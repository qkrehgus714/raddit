/**
 * 외부 API 클라이언트 — ApeWisdom · Yahoo Finance · 레딧 RSS.
 *
 * 모든 fetch에 Next 데이터 캐시(revalidate)를 건다. 인메모리 캐시(lib/cache.ts)와 달리
 * 서버리스 인스턴스를 넘나들며 공유되므로, 콜드 스타트 직후에도 업스트림을 다시
 * 두드리지 않는다. revalidate 값은 서비스 레이어의 TTL보다 약간 짧게 잡아
 * 메모리 캐시가 만료됐을 때 신선한 값을 받아오게 한다.
 */
import { Point, RANGE_SPEC } from "./indicators";

const APEWISDOM_URL = (filter: string, page: number) =>
  `https://apewisdom.io/api/v1.0/filter/${filter}/page/${page}`;
const YAHOO_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;
const YAHOO_QUOTE_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
// 필터링(주 종목·최근 3개월)으로 걸러질 것을 감안해 넉넉히 받아온다 — 표시는 서비스 레이어가 8건으로 자름
const NEWS_SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=25`;
const SYMBOL_SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;

// 레딧 수집은 별도 Python RPC 마이크로서비스(raddit-reddit)에 위임한다.
// Node(undici)의 TLS 지문이 Reddit에 차단(403/429)되기 때문 — 이슈 #13.
// Python stdlib urllib 지문은 통과하므로 그쪽에서 RSS를 수집해 JSON으로 받는다.
const REDDIT_RPC_URL = process.env.REDDIT_RPC_URL?.replace(/\/$/, "");
const REDDIT_RPC_KEY = process.env.REDDIT_RPC_KEY;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function get(url: string, revalidate: number): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`업스트림 응답 ${res.status} (${new URL(url).hostname})`);
  return res;
}

// v7/finance/quote(호가) 등 일부 Yahoo 엔드포인트는 세션 쿠키 + crumb 없이는
// "Invalid Cookie"/"Invalid Crumb"로 거부한다 (v8 차트 엔드포인트는 인증 불필요, 별개).
// 쿠키는 fc.yahoo.com에서, crumb는 그 쿠키로 /v1/test/getcrumb에서 발급받는다.
// 인스턴스 수명 동안 재사용 — 매 요청마다 두 단계를 왕복하지 않도록.
let yahooAuth: { cookie: string; crumb: string; expiresAt: number } | null = null;
let yahooAuthPromise: Promise<{ cookie: string; crumb: string }> | null = null;

async function bootstrapYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER_UA } });
  const cookie = cookieRes.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
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

async function getJson(url: string, revalidate: number): Promise<any> {
  return (await get(url, revalidate)).json();
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
}

export async function fetchMentions(filter: string): Promise<MentionItem[]> {
  const first = await getJson(APEWISDOM_URL(filter, 1), 110);
  let results: MentionItem[] = first.results ?? [];
  const pages = Math.min(Number(first.pages) || 1, 30);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => getJson(APEWISDOM_URL(filter, i + 2), 110)),
  );
  for (const r of rest) results = results.concat(r.results ?? []);
  results.sort((a, b) => b.mentions - a.mentions);
  return results;
}

export interface Quote {
  price: number;
  day_change_pct: number | null;
  volume: number | null;
}

export async function fetchQuote(ticker: string): Promise<Quote | null> {
  try {
    const data = await getJson(YAHOO_URL(ticker), 90);
    const meta = data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose;
    if (price == null) return null;
    return {
      price,
      day_change_pct: prev ? ((price - prev) / prev) * 100 : null,
      volume: meta.regularMarketVolume ?? null,
    };
  } catch {
    return null;
  }
}

export interface BidAsk {
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  /** 호가 잔량 중 매수(bid) 비중(%). 장외 등 호가가 없으면 null. */
  buy_ratio_pct: number | null;
  /** Yahoo marketState — PRE·REGULAR·POST·POSTPOST·CLOSED 등. */
  market_state: string | null;
  /** 장외(프리·애프터) 현재가. 정규장 중이거나 장외 시세가 없으면 null. */
  ext_price: number | null;
  /** 장외 등락률(%) — 정규장 종가 대비. */
  ext_change_pct: number | null;
}

function parseBidAsk(q: any): BidAsk {
  const bidSize: number | null = q.bidSize ?? null;
  const askSize: number | null = q.askSize ?? null;
  const total = (bidSize ?? 0) + (askSize ?? 0);
  // 차트 meta의 regularMarketPrice는 정규장 마감가에 고정되므로, 장외 시간에는
  // v7 quote의 pre/postMarket 필드가 유일한 현재가 소스다 (#72).
  // POSTPOST·CLOSED에도 postMarket 값을 유지 — 애프터 종료 후에도 마지막 장외가가 유효.
  const state: string | null = q.marketState ?? null;
  let extPrice: number | null = null;
  let extPct: number | null = null;
  if (state === "PRE" && q.preMarketPrice != null) {
    extPrice = q.preMarketPrice;
    extPct = q.preMarketChangePercent ?? null;
  } else if (["POST", "POSTPOST", "CLOSED"].includes(state ?? "") && q.postMarketPrice != null) {
    extPrice = q.postMarketPrice;
    extPct = q.postMarketChangePercent ?? null;
  }
  return {
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    bid_size: bidSize,
    ask_size: askSize,
    buy_ratio_pct: total > 0 ? round4((bidSize! / total) * 100) : null,
    market_state: state,
    ext_price: extPrice == null ? null : round4(extPrice),
    ext_change_pct: extPct == null ? null : round4(extPct),
  };
}

/**
 * 호가 잔량(bid/ask size) 기반 매수/매도 비율 — Yahoo Finance L1 시세 스냅샷.
 * 실제 체결 기반 매수/매도 비율이 아니라 한 시점의 호가 잔량 비중이라 참고용.
 */
export async function fetchBidAsk(ticker: string, retry = true): Promise<BidAsk | null> {
  try {
    const { cookie, crumb } = await getYahooAuth();
    const url = `${YAHOO_QUOTE_URL(ticker)}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
      next: { revalidate: 45 },
    });
    if (!res.ok) {
      // 세션 만료 등으로 거부됐을 수 있음 — 인증을 새로 받아 한 번만 재시도
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

/** 상위 티커들의 주가를 병렬 조회 (동시 10개 제한 — Yahoo 요청 제한 회피). */
export async function attachQuotes(items: MentionItem[], concurrency = 10): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        items[i].quote = await fetchQuote(items[i].ticker);
      }
    }),
  );
}

export interface ChartData { meta: Record<string, any>; points: Point[]; }

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * 지정 범위·간격의 시세 시계열 원본 조회.
 * 시가·고가·저가가 비어 있는 봉은 종가로 채워 캔들 표시가 끊기지 않게 한다.
 */
async function fetchChartRaw(
  ticker: string, range: string, interval: string, prepost: boolean, revalidate: number,
): Promise<ChartData> {
  const url = `${YAHOO_URL(ticker)}?range=${range}&interval=${interval}&includePrePost=${prepost}`;
  const result = (await getJson(url, revalidate)).chart.result[0];
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

/** 월봉 시계열을 연도 단위 연봉으로 집계 (Yahoo에 1y interval이 없음). */
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

/**
 * 탭(봉 간격) 기준 시세 시계열 (#18).
 * 분 탭은 프리·애프터마켓 포함 (페니주식은 장외 급등락이 잦음),
 * 년 탭은 전체 월봉을 받아 연봉으로 집계해 돌려준다.
 */
export async function fetchChart(ticker: string, rng: string): Promise<ChartData> {
  const spec = RANGE_SPEC[rng];
  const revalidate = rng === "min" ? 55 : rng === "day" ? 290 : 590;
  const chart = await fetchChartRaw(ticker, spec.range, spec.interval, rng === "min", revalidate);
  return rng === "year" ? { meta: chart.meta, points: aggregateYearly(chart.points) } : chart;
}

/** 기술 지표 분석용 1년 일봉 — 탭 범위와 무관한 내부 전용 조회. */
export function fetchDailyChart(ticker: string): Promise<ChartData> {
  return fetchChartRaw(ticker, "1y", "1d", false, 590);
}

export interface RedditPost { title: string; url: string | null; subreddit: string | null; ts: number | null; }

/**
 * 주식 서브레딧들에서 티커를 검색한 최근 1개월 게시물.
 * Reddit 호출 자체는 raddit-reddit(Python RPC)에 맡긴다. 여기선 단순 HTTP 호출.
 * RPC 서비스 미설정(REDDIT_RPC_URL 없음) 시 빈 배열 + 에러 메시지를 던져
 * 상위 서비스 레이어(getPosts)가 뉴스만이라도 반환하도록 한다.
 */
export async function fetchRedditPosts(ticker: string, limit = 15): Promise<RedditPost[]> {
  if (!REDDIT_RPC_URL) {
    throw new Error("REDDIT_RPC_URL 이 설정되지 않음 (raddit-reddit 서비스 미구성)");
  }
  const url = `${REDDIT_RPC_URL}/rpc/reddit-posts?ticker=${encodeURIComponent(ticker)}&limit=${limit}`;
  const headers: Record<string, string> = {};
  if (REDDIT_RPC_KEY) headers["X-RPC-Key"] = REDDIT_RPC_KEY;
  const res = await fetch(url, { headers, next: { revalidate: 590 } });
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
  /** 기사에 태그된 종목들 — 첫 원소가 기사의 주 종목. 필터링용, 응답 전에 제거됨 */
  relatedTickers?: string[];
}

/** Yahoo Finance 검색 API의 티커 관련 뉴스 (무필터 원본 — 필터링은 서비스 레이어 담당). */
export async function fetchNews(ticker: string): Promise<NewsItem[]> {
  const data = await getJson(NEWS_SEARCH_URL(ticker), 590);
  return (data.news ?? []).map((n: any) => ({
    title: n.title,
    publisher: n.publisher,
    url: n.link,
    ts: n.providerPublishTime,
    relatedTickers: n.relatedTickers,
  }));
}

export interface SymbolItem { ticker: string; name: string | null; exchange: string | null; }

/** 티커·회사명으로 심볼 검색 (Yahoo Finance 자동완성). */
export async function searchSymbols(query: string): Promise<SymbolItem[]> {
  const data = await getJson(SYMBOL_SEARCH_URL(query), 590);
  return (data.quotes ?? [])
    .filter((q: any) => q.symbol && ["EQUITY", "ETF"].includes(q.quoteType))
    .map((q: any) => ({
      ticker: q.symbol,
      name: q.shortname ?? q.longname ?? null,
      exchange: q.exchDisp ?? null,
    }));
}
