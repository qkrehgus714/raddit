/**
 * 뉴스 선행 급등 탐지 (#74) — 감지 판정·링버퍼·알림 이력·폴링 루프.
 * 판정(judgeSpike)·장시간 판단(isMarketWindow)은 순수 함수로 유지해 테스트한다.
 */

import * as up from "./upstream";

// 감지 튜닝 상수 — 임계값 조정은 여기서만
export const SPIKE = {
  POLL_MS: 90_000,           // 폴링 간격
  WINDOW_MIN: 15,            // 급등 판정 구간(분)
  MIN_HISTORY_MIN: 10,       // 판정에 필요한 최소 이력(분)
  PCT_REGULAR: 3,            // 정규장 상승률 임계(%)
  PCT_EXT: 5,                // 장외 상승률 임계(%) — 거래량 검증 불가라 상향
  VOL_RATIO: 5,              // 거래량 배율 임계 (10일 평균의 분당 환산 대비)
  MIN_AVG_VOL: 50_000,       // 초저유동성 컷 (10일 평균 주식수)
  COOLDOWN_MS: 60 * 60_000,  // 같은 티커 재감지 금지 구간
  SNAP_KEEP_MIN: 45,         // 링버퍼 보존(분)
  ALERT_KEEP_MS: 48 * 3600_000, // 알림 이력 보존
  ALERT_MAX: 200,            // 알림 이력 최대 건수
  NEWS_FRESH_SEC: 12 * 3600, // "뉴스 있음" 판단 기준(최근 12시간)
  WATCH_MAX: 120,            // 감시 대상 티커 수
} as const;

export interface SpikeSnapshot {
  t: number;              // epoch sec
  price: number;          // 유효가 (장외 시간엔 장외가)
  cumVol: number | null;  // 당일 누적 거래량 (regularMarketVolume)
  state: string;          // PRE·REGULAR·POST·POSTPOST·CLOSED
}

export interface SpikeVerdict {
  price: number;
  change_pct: number;
  vol_ratio: number | null; // 장외 감지는 null
  market_state: string;
}

/**
 * 스냅샷 링버퍼로 급등 여부 판정.
 * 정규장: WINDOW_MIN분 상승률 ≥ PCT_REGULAR AND 거래량 배율 ≥ VOL_RATIO.
 * 장외: 상승률 ≥ PCT_EXT만 (Yahoo가 장외 거래량을 주지 않음).
 * avg_vol_10d 미상·저유동성이면 판정하지 않는다 (스프레드 왜곡 방지).
 */
export function judgeSpike(
  snaps: SpikeSnapshot[], avgVol10d: number | null, nowSec: number,
): SpikeVerdict | null {
  if (avgVol10d == null || avgVol10d < SPIKE.MIN_AVG_VOL) return null;
  const last = snaps[snaps.length - 1];
  if (!last) return null;
  // 판정 구간 시작점: WINDOW_MIN분 내에서 가장 오래된 스냅샷
  const from = nowSec - SPIKE.WINDOW_MIN * 60;
  const base = snaps.find(s => s.t >= from);
  if (!base || base === last || !base.price) return null;
  const elapsedSec = last.t - base.t;
  if (elapsedSec < SPIKE.MIN_HISTORY_MIN * 60) return null;

  const changePct = (last.price / base.price - 1) * 100;
  const regular = last.state === "REGULAR";
  let volRatio: number | null = null;
  if (regular && last.cumVol != null && base.cumVol != null) {
    const delta = last.cumVol - base.cumVol;
    if (delta >= 0) {
      // 10일 평균을 정규장 390분 기준 분당으로 환산해 같은 시간분량과 비교
      const expected = (avgVol10d / 390) * (elapsedSec / 60);
      if (expected > 0) volRatio = delta / expected;
    }
  }
  const hit = regular
    ? changePct >= SPIKE.PCT_REGULAR && volRatio != null && volRatio >= SPIKE.VOL_RATIO
    : changePct >= SPIKE.PCT_EXT;
  return hit
    ? { price: last.price, change_pct: changePct, vol_ratio: volRatio, market_state: last.state }
    : null;
}

/** 미 동부시간 기준 평일 4:00~20:00 (프리마켓 개장~애프터마켓 마감). DST는 타임존이 흡수. */
export function isMarketWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  return !["Sat", "Sun"].includes(get("weekday")) && hour >= 4 && hour < 20;
}

// ── 알림 이력·폴링 상태 (인메모리 — 재배포 시 소실 허용, 스펙 참조) ──

export interface SpikeAlert {
  ticker: string;
  name: string | null;
  detected_at: number;            // epoch sec
  price: number;                  // 감지 시점 가격
  change_pct: number;
  vol_ratio: number | null;
  market_state: string;
  news: "none" | "recent" | "unknown";
  news_title: string | null;
  news_url: string | null;
  last_price: number | null;      // 폴러가 매 주기 갱신
  since_pct: number | null;       // 감지가 대비 현재 등락
}

export interface AlertsPayload {
  generated_at: string;
  market_open: boolean;
  alerts: SpikeAlert[];
}

const snapsByTicker = new Map<string, SpikeSnapshot[]>();
const lastAlertAt = new Map<string, number>();   // 쿨다운용 (epoch ms)
let alerts: SpikeAlert[] = [];

/** 테스트 전용 — 모듈 상태 초기화. */
export function _resetSpikeState(): void {
  snapsByTicker.clear();
  lastAlertAt.clear();
  alerts = [];
}

/** 알림을 최신순 이력에 추가하고 보존 기준(48h·200건)으로 트리밍. */
export function recordAlert(a: SpikeAlert, nowMs: number = Date.now()): void {
  alerts.unshift(a);
  const cutoffSec = (nowMs - SPIKE.ALERT_KEEP_MS) / 1000;
  alerts = alerts.filter(x => x.detected_at >= cutoffSec).slice(0, SPIKE.ALERT_MAX);
}

export function getAlerts(): AlertsPayload {
  return {
    generated_at: new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }),
    market_open: isMarketWindow(),
    alerts,
  };
}

/** 쿨다운 시작 — 이 시각부터 COOLDOWN_MS 동안 같은 티커 재감지 금지. */
export function markAlerted(ticker: string, nowMs: number): void {
  lastAlertAt.set(ticker, nowMs);
}

/** 쿨다운 중인지 — 순수 조회 (폴러와 테스트가 공유). */
export function underCooldown(ticker: string, nowMs: number): boolean {
  const at = lastAlertAt.get(ticker);
  return at != null && nowMs - at < SPIKE.COOLDOWN_MS;
}

/** 감지 시점 뉴스 유무 — 실패는 unknown ("없음"으로 단정하지 않는다, 스펙 참조). */
async function checkNews(ticker: string): Promise<Pick<SpikeAlert, "news" | "news_title" | "news_url">> {
  try {
    const items = await up.fetchNews(ticker);
    const cutoff = Date.now() / 1000 - SPIKE.NEWS_FRESH_SEC;
    const fresh = items
      .filter(n => n.ts != null && n.ts >= cutoff)
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    return fresh.length
      ? { news: "recent", news_title: fresh[0].title ?? null, news_url: fresh[0].url ?? null }
      : { news: "none", news_title: null, news_url: null };
  } catch {
    return { news: "unknown", news_title: null, news_url: null };
  }
}

/** 1회 폴링: 감시 대상 스냅샷 축적 → 판정 → 알림 기록 → 기존 알림 시세 갱신. */
async function pollOnce(): Promise<void> {
  const mentions = await up.fetchMentions("all-stocks");
  const tickers = mentions.slice(0, SPIKE.WATCH_MAX).map(m => m.ticker);
  const quotes = await up.fetchSpikeQuotes(tickers);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  for (const [ticker, q] of quotes) {
    const price = q.ext_price ?? q.price;
    if (price == null || price <= 0) continue;

    const snaps = snapsByTicker.get(ticker) ?? [];
    snaps.push({ t: nowSec, price, cumVol: q.volume, state: q.market_state ?? "REGULAR" });
    while (snaps.length && snaps[0].t < nowSec - SPIKE.SNAP_KEEP_MIN * 60) snaps.shift();
    snapsByTicker.set(ticker, snaps);

    // 기존 알림의 "감지 후 등락" 갱신 — 같은 배치 응답이라 무비용
    for (const a of alerts) {
      if (a.ticker === ticker) {
        a.last_price = price;
        a.since_pct = (price / a.price - 1) * 100;
      }
    }

    if (underCooldown(ticker, nowMs)) continue;
    const verdict = judgeSpike(snaps, q.avg_vol_10d, nowSec);
    if (!verdict) continue;

    markAlerted(ticker, nowMs);
    const news = await checkNews(ticker);
    recordAlert({
      ticker, name: q.name, detected_at: nowSec, ...verdict, ...news,
      last_price: price, since_pct: 0,
    }, nowMs);
    console.log(`[spike] ${ticker} +${verdict.change_pct.toFixed(1)}% ` +
      `(${verdict.market_state}, vol×${verdict.vol_ratio?.toFixed(1) ?? "-"}, 뉴스 ${news.news})`);
  }
}

// ── 폴링 루프 기동 ──

let failStreak = 0;

/** 폴러 기동 — 멱등. 미들웨어가 요청마다 부르지만 globalThis 가드로 1회만. */
export function ensureSpikeWatch(): void {
  const g = globalThis as { __radditSpikeWatch?: boolean };
  if (g.__radditSpikeWatch) return;
  if (process.env.SPIKE_WATCH === "0") return;
  g.__radditSpikeWatch = true;
  console.log("[spike] 급등 감시 시작 (90초 간격, ET 4:00~20:00 평일)");

  const tick = async () => {
    let delay: number = SPIKE.POLL_MS;
    try {
      if (isMarketWindow()) await pollOnce();
      failStreak = 0;
    } catch (e) {
      failStreak++;
      console.error(`[spike] 폴링 실패 (${failStreak}연속):`, e instanceof Error ? e.message : e);
      if (failStreak >= 3) delay = 600_000; // 10분 백오프
    }
    setTimeout(tick, delay).unref?.();
  };
  setTimeout(tick, 5_000).unref?.(); // 기동 직후 요청 처리에 방해되지 않게 5초 뒤 시작
}
