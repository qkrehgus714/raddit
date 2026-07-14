/**
 * 서비스 레이어 — 라우트 핸들러가 호출하는 비즈니스 로직 + 인메모리 캐시.
 */
import { TtlCache } from "./cache";
import { analyze, computeOverlays } from "./indicators";
import type { Point, Analysis, OverlayRow } from "./indicators";
import * as up from "./upstream";


// 파이썬 버전과 동일한 TTL (밀리초). 두 번째 인자는 stale 허용 구간.
const dataCache = new TtlCache<DataPayload>(120_000, 240_000);
const detailCache = new TtlCache<DetailPayload>(300_000, 300_000);
const dailyCache = new TtlCache<up.ChartData>(600_000, 600_000);
const postsCache = new TtlCache<PostsPayload>(600_000, 300_000);
const searchCache = new TtlCache<SearchPayload>(600_000, 600_000);
const fundamentalsCache = new TtlCache<FundamentalsPayload>(600_000, 600_000);
// StockTwits 공개 엔드포인트가 Cloudflare JS 챌린지(403) 로 서버사이드 차단 —
// 소스 결정(#40/#56) 전까지 dormant. STOCKTWITS_ENABLED=1 시에만 호출·노출.
const ST_ENABLED = process.env.STOCKTWITS_ENABLED === "1";

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
    // 전수 batch 가격조회 (상위 N slice 제거 — 페니주식이 멘션 하위권에 묻혀 누락되는 문제 방지)
    await up.attachQuotesBatch(all);
    // Yahoo 대량 실패(429 등) 시 빈 결과가 캐시를 덮어쓰는 것을 방지 — 누락률이 비정상적으로
    // 높으면 throw하여 TtlCache의 stale-if-error가 직전 정상 스냅샷을 서빙하게 함
    if (all.length > 10) {
      const withQuote = all.filter(it => it.quote && it.quote.price != null).length;
      if (withQuote / all.length < 0.3) {
        throw new Error(`시세 조회 대량 실패 (quote ${withQuote}/${all.length}) — Yahoo 레이트리밋 의심`);
      }
    }
    const items = all.filter(it => {
      if (!it.quote || it.quote.price == null) return false;
      if (maxPrice > 0) {
        if (it.quote.price >= maxPrice) return false;
        // 페니모드: 실제 주식(EQUITY)만 — 레버리지 ETF(SOXS·MSOS 등) 노이즈 제외
        if (it.quote.type && it.quote.type !== "EQUITY") return false;
      }
      return true;
    });
    // 표시 대상(필터 후)에만 호가잔량 비율 부착 — 배치(v7/quote+crumb)
    await up.attachBidAskBatch(items);
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
  return dailyCache.getOrCompute(ticker, () => up.fetchDailyChart(ticker));
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
  bid_size: number | null;
  ask_size: number | null;
  buy_ratio_pct: number | null;
  generated_at: string;
}

export function detailTtlSec(rng: string): number {
  // 분 탭은 준실시간(60초 자동 갱신에 맞춤), 주·월·년은 봉이 느리게 바뀌므로 길게
  return rng === "min" ? 60 : rng === "day" ? 300 : 600;
}

export async function getDetail(ticker: string, rng: string): Promise<DetailPayload> {
  return detailCache.getOrCompute(`${ticker}|${rng}`, async () => {
    const [chart, daily, bidAsk] = await Promise.all([
      up.fetchChart(ticker, rng), getDaily(ticker), up.fetchBidAsk(ticker),
    ]);
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
      // 20·50일 이평선+볼린저 오버레이 — 일봉 탭에서만 의미가 있음 (주·월·년은 간격 불일치)
      overlays: rng === "day" ? computeOverlays(daily.points) : null,
      analysis: analyze(daily.points, daily.meta),
      bid_size: bidAsk?.bid_size ?? null,
      ask_size: bidAsk?.ask_size ?? null,
      buy_ratio_pct: bidAsk?.buy_ratio_pct ?? null,
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
  stocktwits: up.StocktwitsSentiment | null;
  st_error: string | null;
  st_enabled: boolean;
  generated_at: string;
}

const reason = (r: PromiseRejectedResult): string =>
  r.reason instanceof Error ? r.reason.message : String(r.reason);

const NEWS_MAX = 8;
const NEWS_MAX_AGE_SEC = 90 * 86400; // 최근 3개월 이내 기사만
const NEWS_RELAX_MIN = 3;            // 주 종목 필터 결과가 이보다 적으면 완화

/**
 * 회사명을 제목 매칭용 정규식으로. 법인 접미사(Inc., Corp. 등)를 떼어내
 * "GameStop Corp." 같은 풀네임이 제목의 "GameStop"과 매칭되게 한다.
 */
function companyNamePattern(name: string | null): RegExp | null {
  if (!name) return null;
  const core = name
    .replace(/[,.]/g, " ")
    .replace(/\b(incorporated|corporation|company|limited|holdings?|inc|corp|ltd|llc|plc|co)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  if (core.length < 3) return null; // 너무 짧으면 오매칭 위험 — 이름 매칭 포기
  return new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

/**
 * 무관한 종목 기사 혼입 방지 (#5) + 최근 3개월 제한.
 * 1차: 주 종목(relatedTickers[0]) 기사 또는 제목에 회사명이 있는 기사.
 * 2차: 1차가 NEWS_RELAX_MIN 미만이면 티커가 언급이라도 된 기사로 완화.
 * 메타데이터가 아예 없으면 필터를 포기하고 원본을 보여준다 (빈 목록보다 낫다).
 */
function filterNews(items: up.NewsItem[], ticker: string, name: string | null): up.NewsItem[] {
  const cutoff = Date.now() / 1000 - NEWS_MAX_AGE_SEC;
  const fresh = items.filter(n => n.ts != null && n.ts >= cutoff);
  const nameRe = companyNamePattern(name);
  let picked = fresh.filter(n =>
    n.relatedTickers?.[0] === ticker || (nameRe != null && nameRe.test(n.title ?? "")));
  if (picked.length < NEWS_RELAX_MIN) {
    const relaxed = fresh.filter(n => !picked.includes(n) && n.relatedTickers?.includes(ticker));
    picked = [...picked, ...relaxed];
  }
  if (picked.length === 0) picked = fresh;
  return picked.slice(0, NEWS_MAX).map(({ relatedTickers: _unused, ...rest }) => rest);
}

/** 레딧 게시물 + 뉴스를 병렬로 수집. 한쪽이 실패해도 나머지는 반환. */
export async function getPosts(ticker: string): Promise<PostsPayload> {
  return postsCache.getOrCompute(ticker, async () => {
    const [reddit, news, daily, st] = await Promise.allSettled([
      up.fetchRedditPosts(ticker),
      up.fetchNews(ticker),
      getDaily(ticker), // 회사명 확보용 — 상세 모달의 일봉 캐시와 공유되어 대부분 무비용
      ST_ENABLED ? up.fetchStocktwitsSentiment(ticker) : Promise.resolve(null),
    ]);
    const name = daily.status === "fulfilled"
      ? ((daily.value.meta.shortName ?? daily.value.meta.longName ?? null) as string | null)
      : null;
    return {
      ticker,
      reddit: reddit.status === "fulfilled" ? reddit.value : [],
      news: news.status === "fulfilled" ? filterNews(news.value, ticker, name) : [],
      reddit_error: reddit.status === "rejected" ? reason(reddit) : null,
      news_error: news.status === "rejected" ? reason(news) : null,
      stocktwits: ST_ENABLED && st.status === "fulfilled" ? st.value : null,
      st_error: ST_ENABLED && st.status === "rejected" ? reason(st) : null,
      st_enabled: ST_ENABLED,
      generated_at: kstTime(),
    };
  }, {
    // 일부 실패한 응답은 짧게만 캐시 — 곧 재시도할 수 있게
    // (st_error 는 분리 — StockTwits 실패가 레딧/뉴스 캐시를 단축시키지 않게)
    ttlFor: v => (v.reddit_error || v.news_error ? 60_000 : 600_000),
  });
}

export interface FundamentalsPayload {
  ticker: string;
  data: up.Fundamentals | null;
  error: string | null;
  generated_at: string;
}

/** SEC EDGAR 펀더멘털(공시·재무) — getPosts 와 동일하게 독립 캐시·장애 격리.
 *  EDGAR 장애는 error 에만 담기고 다른 패널에 영향을 주지 않는다. */
export async function getFundamentals(ticker: string): Promise<FundamentalsPayload> {
  return fundamentalsCache.getOrCompute(ticker, async () => {
    try {
      return { ticker, data: await up.fetchFundamentals(ticker), error: null, generated_at: kstTime() };
    } catch (e: any) {
      return { ticker, data: null, error: e?.message ?? String(e), generated_at: kstTime() };
    }
  }, {
    // EDGAR 일시 장애 응답은 짧게 캐시해 곧 재시도
    ttlFor: v => v.error ? 60_000 : 600_000,
  });
}

export interface SearchPayload { query: string; items: up.SymbolItem[]; }

export async function getSearch(query: string): Promise<SearchPayload> {
  return searchCache.getOrCompute(query.toLowerCase(), async () => ({
    query,
    items: await up.searchSymbols(query),
  }));
}
