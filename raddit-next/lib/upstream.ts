/**
 * 외부 API 클라이언트 — ApeWisdom · Yahoo Finance · 레딧 RSS.
 *
 * 모든 fetch에 Next 데이터 캐시(revalidate)를 건다. 인메모리 캐시(lib/cache.ts)와 달리
 * 서버리스 인스턴스를 넘나들며 공유되므로, 콜드 스타트 직후에도 업스트림을 다시
 * 두드리지 않는다. revalidate 값은 서비스 레이어의 TTL보다 약간 짧게 잡아
 * 메모리 캐시가 만료됐을 때 신선한 값을 받아오게 한다.
 */
import { XMLParser } from "fast-xml-parser";
import { Point, RANGE_INTERVAL } from "./indicators";

const APEWISDOM_URL = (filter: string, page: number) =>
  `https://apewisdom.io/api/v1.0/filter/${filter}/page/${page}`;
const YAHOO_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;
const NEWS_SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=8`;
const SYMBOL_SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;

// 레딧 JSON API는 비로그인 요청을 403으로 차단하지만 RSS 검색 피드는 열려 있다.
const REDDIT_SEARCH_SUBS = "pennystocks+wallstreetbets+stocks+investing+Shortsqueeze+smallstreetbets";
const REDDIT_RSS_URL = (ticker: string, limit: number) =>
  `https://www.reddit.com/r/${REDDIT_SEARCH_SUBS}/search.rss` +
  `?q=${encodeURIComponent(`"${ticker}"`)}&restrict_sr=on&sort=new&t=month&limit=${limit}`;

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
 * 지정 범위의 시세 시계열. 1일 차트는 프리·애프터마켓 포함 (페니주식은 장외 급등락이 잦음).
 * 시가·고가·저가가 비어 있는 봉은 종가로 채워 캔들 표시가 끊기지 않게 한다.
 */
export async function fetchChart(ticker: string, rng: string): Promise<ChartData> {
  const prepost = rng === "1d" ? "true" : "false";
  const url = `${YAHOO_URL(ticker)}?range=${rng}&interval=${RANGE_INTERVAL[rng]}&includePrePost=${prepost}`;
  const revalidate = rng === "1d" ? 55 : rng === "1y" ? 590 : 290;
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

export interface RedditPost { title: string; url: string | null; subreddit: string | null; ts: number | null; }

/** 주식 서브레딧들에서 티커를 검색한 최근 1개월 게시물 (Atom 피드 파싱). */
export async function fetchRedditPosts(ticker: string, limit = 15): Promise<RedditPost[]> {
  const body = await (await get(REDDIT_RSS_URL(ticker, limit), 590)).text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const feed = parser.parse(body);
  let entries = feed?.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];
  const text = (v: unknown): string =>
    typeof v === "object" && v !== null ? String((v as any)["#text"] ?? "") : String(v ?? "");
  const posts: RedditPost[] = entries.map((e: any) => {
    const updated = Date.parse(text(e.updated));
    return {
      title: text(e.title),
      url: e.link?.["@_href"] ?? null,
      subreddit: e.category?.["@_label"] ?? null,
      ts: Number.isNaN(updated) ? null : Math.floor(updated / 1000),
    };
  });
  posts.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return posts;
}

export interface NewsItem { title?: string; publisher?: string; url?: string; ts?: number; }

/** Yahoo Finance 검색 API의 티커 관련 뉴스. */
export async function fetchNews(ticker: string): Promise<NewsItem[]> {
  const data = await getJson(NEWS_SEARCH_URL(ticker), 590);
  return (data.news ?? []).map((n: any) => ({
    title: n.title,
    publisher: n.publisher,
    url: n.link,
    ts: n.providerPublishTime,
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
