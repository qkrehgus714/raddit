/**
 * 외부 API 클라이언트 — ApeWisdom · Yahoo Finance · 레딧 RPC.
 *
 * Astro 마이그레이션: Next.js fetch revalidate → 순수 fetch.
 * 캐싱은 인메모리 TTL (lib/cache.ts)이 담당.
 */
import type { Point } from "./indicators";
import { RANGE_SPEC } from "./indicators";

const APEWISDOM_URL = (filter: string, page: number) =>
  `https://apewisdom.io/api/v1.0/filter/${filter}/page/${page}`;
const YAHOO_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;
const YAHOO_QUOTE_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
const NEWS_SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=25`;
const SYMBOL_SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;

const REDDIT_RPC_URL = process.env.REDDIT_RPC_URL?.replace(/\/$/, "");
const REDDIT_RPC_KEY = process.env.REDDIT_RPC_KEY;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function getJson(url: string, init?: { headers?: Record<string, string> }): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`업스트림 응답 ${res.status} (${new URL(url).hostname})`);
  return res.json();
}

// Yahoo v7/quote 인증 (쿠키 + crumb)
let yahooAuth: { cookie: string; crumb: string; expiresAt: number } | null = null;
let yahooAuthPromise: Promise<{ cookie: string; crumb: string }> | null = null;

async function bootstrapYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(10000) });
  const cookie = cookieRes.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });
  if (!crumbRes.ok) throw new Error(`Yahoo crumb 발급 실패 ${crumbRes.status}`);
  const crumb = await crumbRes.text();
  const auth = { cookie, crumb, expiresAt: Date.now() + 3600_000 };
  yahooAuth = auth;
  return auth;
}

async function getYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  if (yahooAuth && yahooAuth.expiresAt > Date.now()) return yahooAuth;
  if (!yahooAuthPromise) yahooAuthPromise = bootstrapYahooAuth().finally(() => { yahooAuthPromise = null; });
  return yahooAuthPromise;
}

export interface MentionItem {
  rank: number;
  ticker: string;
  name?: string;
  mentions: number;
  upvotes: number;
  rank_24h_ago?: number;
  mentions_24h_ago?: number;
  quote?: Quote | null;
  buy_ratio_pct?: number | null;
  bidAskTotal?: number | null;
}

export async function fetchMentions(filter: string): Promise<MentionItem[]> {
  const first = await getJson(APEWISDOM_URL(filter, 1));
  let results: MentionItem[] = first.results ?? [];
  const pages = Math.min(Number(first.pages) || 1, 30);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => getJson(APEWISDOM_URL(filter, i + 2))),
  );
  for (const r of rest) results = results.concat(r.results ?? []);
  results.sort((a, b) => b.mentions - a.mentions);
  return results;
}

export interface Quote {
  price: number;
  day_change_pct: number | null;
  volume: number | null;
  type?: string | null;
  exchange?: string | null;
}

/**
 * Yahoo spark 배치 API로 여러 티커의 시세를 한 번에 조회 (비인증, chunkSize 심볼/요청).
 * v8/chart per-ticker 대비 요청 수를 chunkSize 배 절감. 청크 단위 실패는 해당 청크만 skip.
 */
const SPARK_URL = (symbols: string) =>
  `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols)}&range=1d&interval=1d`;

export async function attachQuotesBatch(items: MentionItem[], chunkSize = 20, concurrency = 5): Promise<void> {
  const chunks: MentionItem[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try {
        const data = await getJson(SPARK_URL(chunk.map(c => c.ticker).join(",")));
        const metaByTicker = new Map<string, any>();
        for (const r of data?.spark?.result ?? []) {
          const meta = r.response?.[0]?.meta;
          if (meta?.regularMarketPrice != null) metaByTicker.set(r.symbol, meta);
        }
        for (const c of chunk) {
          const meta = metaByTicker.get(c.ticker);
          if (!meta) continue;
          const price = meta.regularMarketPrice;
          const prev = meta.chartPreviousClose ?? meta.previousClose;
          c.quote = {
            price,
            day_change_pct: prev ? ((price - prev) / prev) * 100 : null,
            volume: meta.regularMarketVolume ?? null,
            type: meta.instrumentType ?? null,
            exchange: meta.exchangeName ?? null,
          };
        }
      } catch {
        // 청크 실패(레이트리밋 등) 시 해당 청크만 skip
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
}

export interface BidAsk {
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  buy_ratio_pct: number | null;
}

function parseBidAsk(q: any): BidAsk {
  const bidSize: number | null = q.bidSize ?? null;
  const askSize: number | null = q.askSize ?? null;
  const total = (bidSize ?? 0) + (askSize ?? 0);
  return {
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    bid_size: bidSize,
    ask_size: askSize,
    buy_ratio_pct: total > 0 ? round4((bidSize! / total) * 100) : null,
  };
}

export async function fetchBidAsk(ticker: string, retry = true): Promise<BidAsk | null> {
  try {
    const { cookie, crumb } = await getYahooAuth();
    const url = `${YAHOO_QUOTE_URL(ticker)}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (retry) { yahooAuth = null; return fetchBidAsk(ticker, false); }
      return null;
    }
    const data = await res.json();
    const q = data.quoteResponse?.result?.[0];
    return q ? parseBidAsk(q) : null;
  } catch {
    return null;
  }
}
/**
 * 호가잔량(매수/매도) 비율을 v7/quote 배치로 조회해 items에 채운다 (crumb 인증).
 * 표시 대상(필터 후) items에만 호출 — 페니모드 ~18건, 전체모드 ~200건.
 * crumb 발급 실패/청크 실패 시 해당 건 buy_ratio_pct=null.
 */
export async function attachBidAskBatch(items: MentionItem[], chunkSize = 40, concurrency = 5): Promise<void> {
  if (!items.length) return;
  let auth: { cookie: string; crumb: string };
  try {
    auth = await getYahooAuth();
  } catch {
    return;
  }
  const fetchChunk = (chunk: MentionItem[], a: { cookie: string; crumb: string }) =>
    fetch(`${YAHOO_QUOTE_URL(chunk.map(c => c.ticker).join(","))}&crumb=${encodeURIComponent(a.crumb)}`, {
      headers: { "User-Agent": BROWSER_UA, Cookie: a.cookie },
      signal: AbortSignal.timeout(10000),
    });
  const applyChunk = (chunk: MentionItem[], data: any) => {
    const byTicker = new Map<string, any>();
    for (const q of data?.quoteResponse?.result ?? []) byTicker.set(q.symbol, q);
    for (const c of chunk) {
      const q = byTicker.get(c.ticker);
      if (!q) continue;
      const ba = parseBidAsk(q);
      c.buy_ratio_pct = ba.buy_ratio_pct;
      const total = (ba.bid_size ?? 0) + (ba.ask_size ?? 0);
      c.bidAskTotal = total > 0 ? total : null;
    }
  };
  const chunks: MentionItem[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try {
        let res = await fetchChunk(chunk, auth);
        // crumb 조기 만료(401/403) 시 재발급 후 1회 재시도 — fetchBidAsk(단일)와 동일 패턴
        if (res.status === 401 || res.status === 403) {
          yahooAuth = null;
          try { auth = await getYahooAuth(); res = await fetchChunk(chunk, auth); } catch { continue; }
        }
        if (!res.ok) continue;
        applyChunk(chunk, await res.json());
      } catch {
        // 청크 실패 시 해당 청크 호가 null
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
}


export interface ChartData { meta: Record<string, any>; points: Point[]; }

function round4(v: number): number { return Math.round(v * 1e4) / 1e4; }

async function fetchChartRaw(
  ticker: string, range: string, interval: string, prepost: boolean,
): Promise<ChartData> {
  const url = `${YAHOO_URL(ticker)}?range=${range}&interval=${interval}&includePrePost=${prepost}`;
  const result = (await getJson(url)).chart.result[0];
  const quote = result.indicators.quote[0];
  const ts: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = quote.close ?? [];
  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const vols: (number | null)[] = quote.volume ?? [];
  const points: Point[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    points.push({
      t: ts[i],
      o: round4(opens[i] ?? c),
      h: round4(highs[i] ?? c),
      l: round4(lows[i] ?? c),
      c: round4(c),
      v: vols[i] ?? null,
    });
  }
  return { meta: result.meta, points };
}

function aggregateYearly(monthly: Point[]): Point[] {
  const out: Point[] = [];
  let cur: Point | null = null;
  let curYear = -1;
  for (const p of monthly) {
    const yr = new Date(p.t * 1000).getUTCFullYear();
    if (!cur || yr !== curYear) {
      if (cur) out.push(cur);
      curYear = yr;
      cur = { ...p };
    } else {
      cur.h = Math.max(cur.h, p.h);
      cur.l = Math.min(cur.l, p.l);
      cur.c = p.c;
      cur.v = cur.v == null && p.v == null ? null : (cur.v ?? 0) + (p.v ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function fetchChart(ticker: string, rng: string): Promise<ChartData> {
  const spec = RANGE_SPEC[rng];
  const chart = await fetchChartRaw(ticker, spec.range, spec.interval, rng === "min");
  return rng === "year" ? { meta: chart.meta, points: aggregateYearly(chart.points) } : chart;
}

export function fetchDailyChart(ticker: string): Promise<ChartData> {
  return fetchChartRaw(ticker, "1y", "1d", false);
}

export interface RedditPost { title: string; url: string | null; subreddit: string | null; ts: number | null; }

export async function fetchRedditPosts(ticker: string, limit = 15): Promise<RedditPost[]> {
  if (!REDDIT_RPC_URL) {
    throw new Error("REDDIT_RPC_URL 이 설정되지 않음 (raddit-reddit 서비스 미구성)");
  }
  const url = `${REDDIT_RPC_URL}/rpc/reddit-posts?ticker=${encodeURIComponent(ticker)}&limit=${limit}`;
  const headers: Record<string, string> = {};
  if (REDDIT_RPC_KEY) headers["X-RPC-Key"] = REDDIT_RPC_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Reddit RPC 응답 ${res.status} (raddit-reddit)`);
  }
  const data = (await res.json()) as { posts?: RedditPost[] };
  return data.posts ?? [];
}

export interface NewsItem {
  title?: string;
  publisher?: string;
  url?: string;
  ts?: number;
  relatedTickers?: string[];
}

export async function fetchNews(ticker: string): Promise<NewsItem[]> {
  const data = await getJson(NEWS_SEARCH_URL(ticker));
  return (data.news ?? []).map((n: any) => ({
    title: n.title,
    publisher: n.publisher,
    url: n.link,
    ts: n.providerPublishTime,
    relatedTickers: n.relatedTickers,
  }));
}

export interface SymbolItem { ticker: string; name: string | null; exchange: string | null; }

export async function searchSymbols(query: string): Promise<SymbolItem[]> {
  const data = await getJson(SYMBOL_SEARCH_URL(query));
  return (data.quotes ?? [])
    .filter((q: any) => q.symbol && ["EQUITY", "ETF"].includes(q.quoteType))
    .map((q: any) => ({
      ticker: q.symbol,
      name: q.shortname ?? q.longname ?? null,
      exchange: q.exchDisp ?? null,
    }));
}

// ── SEC EDGAR (공시·재무제표·현금흐름) ──
// 공식 무료 US-gov API. 식별 가능한 User-Agent 가이드라인 준수 (정책상 필수).
// EDGAR 장애는 다른 패널에 영향을 주지 않는다 — services.getFundamentals 에서 격리.
const SEC_UA = "raddit research admin@example.com";
const secGet = (url: string) => getJson(url, { headers: { "User-Agent": SEC_UA } });

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const submissionsUrl = (cik10: string) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
const companyFactsUrl = (cik10: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

// company_tickers.json 캐시 — 모듈 수준, 6h TTL (티커→CIK 매핑은 거의 안 바뀜)
let tickersCache: { at: number; map: Map<string, string> } | null = null;
const TICKERS_TTL_MS = 6 * 3600_000;

async function getTickerMap(): Promise<Map<string, string>> {
  if (tickersCache && Date.now() - tickersCache.at < TICKERS_TTL_MS) return tickersCache.map;
  const data = await secGet(TICKERS_URL);
  const map = new Map<string, string>();
  for (const k of Object.keys(data || {})) {
    const row = data[k];
    if (row && row.ticker && row.cik_str != null) {
      map.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, "0"));
    }
  }
  tickersCache = { at: Date.now(), map };
  return map;
}

/** 티커 → 10자리 CIK 문자열(0 채움). EDGAR 미등록(OTC/소형주)이면 null.
 *  네트워크 오류는 throw (상위 getFundamentals 가 잡아 격리). */
export async function tickerToCik(ticker: string): Promise<string | null> {
  const map = await getTickerMap();
  return map.get(ticker.toUpperCase()) ?? null;
}

export interface SecFiling {
  form: string; date: string; docDesc: string | null; url: string;
}
export interface SecFinancials {
  revenues_ttm: number | null;
  net_income_ttm: number | null;
  total_assets: number | null;
  eps: number | null;
  cash: number | null;            // 현금 + 단기투자
  operating_cf_ttm: number | null;
  as_of: string | null;           // 가장 최근 fact 기준일 (YYYY-MM-DD)
}
export interface Fundamentals {
  cik: string | null;
  filings: SecFiling[];           // 관련 form(8-K/10-Q/10-K/S-1/SC13) 최근 8건
  financials: SecFinancials | null;
}

// 레딧 워치보드 관심 공시 — 내부자 거래(Form 4) 등 노이즈 제거
const RELEVANT_FORMS = ["8-K", "10-K", "10-Q", "S-1", "SC 13D", "SC 13G"];
const isRelevantForm = (form: string) =>
  RELEVANT_FORMS.some(b => form === b || form.startsWith(b + "/"));

/** us-gaap fact 에서 최근값 추출. preferAnnual=true 면 FY(연간) 우선(TTM 근사),
 *  FY 가 없으면 최근 end 기준. 값/단위가 없으면 null. */
function latestFact(
  cf: any, tag: string, unit: string, preferAnnual = false,
): { end: string; val: number } | null {
  const arr = cf?.facts?.["us-gaap"]?.[tag]?.units?.[unit];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const num = arr.filter((f: any) => typeof f?.val === "number");
  if (num.length === 0) return null;
  const byEndDesc = (a: any, b: any) =>
    a.end < b.end ? 1 : a.end > b.end ? -1 : (b.start ?? "").localeCompare(a.start ?? "");
  if (preferAnnual) {
    const fy = num.filter((f: any) => f.fp === "FY").sort(byEndDesc);
    if (fy.length) return { end: fy[0].end, val: fy[0].val };
  }
  const top = num.slice().sort(byEndDesc)[0];
  return { end: top.end, val: top.val };
}

/** 여러 후보 태그 중 가장 최근 end 의 fact 선택 — 'Revenues' 가 과거에만
 *  보고된 발행사(Apple 등)에서 fallback 태그의 최신값이 이기게 한다. */
function latestAmong(
  cf: any, tags: string[], unit: string, preferAnnual = false,
): { end: string; val: number } | null {
  let best: { end: string; val: number } | null = null;
  for (const tag of tags) {
    const f = latestFact(cf, tag, unit, preferAnnual);
    if (f && (!best || f.end > best.end)) best = f;
  }
  return best;
}

/**
 * SEC EDGAR 펀더멘털 조회 — 최근 관련 공시 + 재무 하이라이트(XBRL).
 * CIK 미등록(OTC/소형주)이면 {cik:null,...} 반환. 네트워크 오류는 throw.
 * submissions/companyfacts 각각 독립 try/catch — 한쪽 실패해도 다른쪽은 채운다.
 */
export async function fetchFundamentals(ticker: string): Promise<Fundamentals | null> {
  const cik = await tickerToCik(ticker);
  if (!cik) return { cik: null, filings: [], financials: null };

  // 1) 공시 — submissions.filings.recent 에서 관련 form 최근 8건
  let filings: SecFiling[] = [];
  try {
    const sub = await secGet(submissionsUrl(cik));
    const r = sub?.filings?.recent;
    if (r && Array.isArray(r.form)) {
      const cikInt = String(parseInt(cik, 10));
      const forms: any[] = r.form;
      const acc: any[] = r.accessionNumber ?? [];
      const dates: any[] = r.filingDate ?? [];
      const pdocs: any[] = r.primaryDocument ?? [];
      const pdesc: any[] = r.primaryDocDescription ?? [];
      for (let i = 0; i < forms.length && filings.length < 8; i++) {
        const form = String(forms[i] ?? "");
        if (!isRelevantForm(form)) continue;
        const accession = acc[i];
        const pdoc = pdocs[i];
        if (!accession || !pdoc) continue;
        filings.push({
          form,
          date: dates[i] ? String(dates[i]) : "",
          docDesc: pdesc[i] ? String(pdesc[i]) : null,
          url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${String(accession).replace(/-/g, "")}/${pdoc}`,
        });
      }
    }
  } catch {
    // submissions 실패 — 공시 빈 목록. 재무는 계속 시도.
  }

  // 2) 재무 — companyfacts XBRL 최근값 (us-gaap)
  let financials: SecFinancials | null = null;
  try {
    const cf = await secGet(companyFactsUrl(cik));
    // 매출/순이익: 동일 의미의 여러 us-gaap 태그 중 가장 최근 end 채택.
    //   'Revenues' 는 Apple 등에서 과거에만 보고 — fallback 태그의 최신값이 우선.
    const rev = latestAmong(cf,
      ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"], "USD", true);
    const ni = latestAmong(cf,
      ["NetIncomeLoss", "ProfitLoss"], "USD", true);
    const assets = latestFact(cf, "Assets", "USD", false);
    const eps = latestFact(cf, "EarningsPerShareBasic", "USD/shares", true);
    const cashF = latestFact(cf, "CashAndCashEquivalentsAtCarryingValue", "USD", false);
    const stiF = latestFact(cf, "ShortTermInvestments", "USD", false);
    const ocf = latestFact(cf, "NetCashProvidedByUsedInOperatingActivities", "USD", true);

    if (rev || ni || assets || eps || cashF || ocf) {
      const cashVal = (cashF?.val ?? 0) + (stiF?.val ?? 0);
      const ends = [rev, ni, assets, eps, cashF, stiF, ocf]
        .map(f => f?.end ?? "").filter(Boolean).sort();
      financials = {
        revenues_ttm: rev?.val ?? null,
        net_income_ttm: ni?.val ?? null,
        total_assets: assets?.val ?? null,
        eps: eps?.val ?? null,
        cash: (cashF?.val != null || stiF?.val != null) ? cashVal : null,
        operating_cf_ttm: ocf?.val ?? null,
        as_of: ends.length ? ends[ends.length - 1] : null,
      };
    }
  } catch {
    // companyfacts 실패 — 재무 null
  }

  return { cik, filings, financials };
}
