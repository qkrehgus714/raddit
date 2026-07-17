/**
 * 뉴스 선행 급등 탐지 (#74) — 감지 판정·링버퍼·알림 이력·폴링 루프.
 * 판정(judgeSpike)·장시간 판단(isMarketWindow)은 순수 함수로 유지해 테스트한다.
 */

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
