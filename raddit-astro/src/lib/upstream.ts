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

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
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
