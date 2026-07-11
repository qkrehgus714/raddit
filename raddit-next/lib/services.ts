/**
 * 서비스 레이어 — 라우트 핸들러가 호출하는 비즈니스 로직 + 인메모리 캐시.
 * server.py의 get_payload / get_detail / get_posts / get_search에 대응한다.
 */
import { TtlCache } from "./cache";
import { analyze, computeOverlays, RANGE_INTERVAL, Point, Analysis, OverlayRow } from "./indicators";
import * as up from "./upstream";

const PRICE_LOOKUP_LIMIT = 120;

// 파이썬 버전과 동일한 TTL (밀리초). 두 번째 인자는 stale 허용 구간.
const dataCache = new TtlCache<DataPayload>(120_000, 240_000);
const detailCache = new TtlCache<DetailPayload>(300_000, 300_000);
const dailyCache = new TtlCache<up.ChartData>(600_000, 600_000);
const postsCache = new TtlCache<PostsPayload>(600_000, 300_000);
const searchCache = new TtlCache<SearchPayload>(600_000, 600_000);

// 파이썬 서버는 PC 로컬 시간(KST)을 썼다 — 클라우드에선 UTC라 명시적으로 서울 시간 포맷
const kstDateTime = () =>
  new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }); // "YYYY-MM-DD HH:mm:ss"
const kstTime = () =>
  new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });

export interface DataPayload {
  generated_at: string;
  filter: string;
  max_price: number;
  scanned: number;
  items: up.MentionItem[];
}

export async function getData(
  filterName: string, maxPrice: number, minMentions: number,
): Promise<DataPayload> {
  const key = `${filterName}|${maxPrice}|${minMentions}`;
  return dataCache.getOrCompute(key, async () => {
    const all = (await up.fetchMentions(filterName)).filter(it => it.mentions >= minMentions);
    const candidates = all.slice(0, PRICE_LOOKUP_LIMIT);
    await up.attachQuotes(candidates);
    const items = maxPrice > 0
      ? candidates.filter(it => it.quote && it.quote.price < maxPrice)
      : candidates;
    return {
      generated_at: kstDateTime(),
      filter: filterName,
      max_price: maxPrice,
      scanned: all.length,
      items,
    };
  });
}

/** 분석 지표 계산용 1년 일봉 (티커당 10분 캐시). */
function getDaily(ticker: string): Promise<up.ChartData> {
  return dailyCache.getOrCompute(ticker, () => up.fetchChart(ticker, "1y"));
}

export interface DetailPayload {
  ticker: string;
  range: string;
  name: string | null;
  currency: string | null;
  exchange: string | null;
  timezone: string | null;
  price: number | null;
  prev_close: number | null;
  regular_start: number | null;
  regular_end: number | null;
  points: Point[];
  overlays: OverlayRow[] | null;
  analysis: Analysis;
  generated_at: string;
}

export function detailTtlSec(rng: string): number {
  return rng === "1d" ? 60 : 300; // 1D는 준실시간으로 자주 갱신
}

export async function getDetail(ticker: string, rng: string): Promise<DetailPayload> {
  return detailCache.getOrCompute(`${ticker}|${rng}`, async () => {
    const [chart, daily] = await Promise.all([up.fetchChart(ticker, rng), getDaily(ticker)]);
    const meta = chart.meta;
    const regular = meta.currentTradingPeriod?.regular ?? {};
    return {
      ticker,
      range: rng,
      name: meta.shortName ?? meta.longName ?? null,
      currency: meta.currency ?? null,
      exchange: meta.exchangeName ?? null,
      timezone: meta.exchangeTimezoneName ?? null,
      price: meta.regularMarketPrice ?? null,
      prev_close: meta.chartPreviousClose ?? meta.previousClose ?? null,
      regular_start: regular.start ?? null,
      regular_end: regular.end ?? null,
      points: chart.points,
      // 이동평균·볼린저밴드 오버레이 — 봉 간격이 일봉인 범위에서만 의미가 있음
      overlays: RANGE_INTERVAL[rng] === "1d" ? computeOverlays(daily.points) : null,
      analysis: analyze(daily.points, daily.meta),
      generated_at: kstTime(),
    };
  }, { ttlMs: detailTtlSec(rng) * 1000 });
}

export interface PostsPayload {
  ticker: string;
  reddit: up.RedditPost[];
  news: up.NewsItem[];
  reddit_error: string | null;
  news_error: string | null;
  generated_at: string;
}

const reason = (r: PromiseRejectedResult): string =>
  r.reason instanceof Error ? r.reason.message : String(r.reason);

/** 레딧 게시물 + 뉴스를 병렬로 수집. 한쪽이 실패해도 나머지는 반환. */
export async function getPosts(ticker: string): Promise<PostsPayload> {
  return postsCache.getOrCompute(ticker, async () => {
    const [reddit, news] = await Promise.allSettled([
      up.fetchRedditPosts(ticker),
      up.fetchNews(ticker),
    ]);
    return {
      ticker,
      reddit: reddit.status === "fulfilled" ? reddit.value : [],
      news: news.status === "fulfilled" ? news.value : [],
      reddit_error: reddit.status === "rejected" ? reason(reddit) : null,
      news_error: news.status === "rejected" ? reason(news) : null,
      generated_at: kstTime(),
    };
  }, {
    // 일부 실패한 응답은 짧게만 캐시 — 곧 재시도할 수 있게
    ttlFor: v => (v.reddit_error || v.news_error ? 60_000 : 600_000),
  });
}

export interface SearchPayload { query: string; items: up.SymbolItem[]; }

export async function getSearch(query: string): Promise<SearchPayload> {
  return searchCache.getOrCompute(query.toLowerCase(), async () => ({
    query,
    items: await up.searchSymbols(query),
  }));
}
