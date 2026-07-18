import { describe, expect, it } from "vitest";
import { judgeSpike, isMarketWindow, SPIKE } from "./spike";
import type { SpikeSnapshot } from "./spike";

/** now 기준 minAgo분 전 스냅샷 생성 헬퍼 */
const NOW = 1_800_000_000; // 임의 epoch sec
const snap = (minAgo: number, price: number, cumVol: number | null, state = "REGULAR"): SpikeSnapshot =>
  ({ t: NOW - minAgo * 60, price, cumVol, state });

describe("judgeSpike — 정규장", () => {
  // 10일 평균 100만주 → 15분 기대 거래량 = 1_000_000/390*15 ≈ 38,462주
  const AVG = 1_000_000;

  it("가격 +3% 이상 AND 거래량 5배 이상 → 감지", () => {
    const v = judgeSpike([snap(15, 1.0, 500_000), snap(0, 1.04, 500_000 + 200_000)], AVG, NOW);
    expect(v).not.toBeNull();
    expect(v!.change_pct).toBeCloseTo(4, 5);
    expect(v!.vol_ratio).toBeGreaterThan(SPIKE.VOL_RATIO);
    expect(v!.market_state).toBe("REGULAR");
  });

  it("완만한 상승(+1%)은 거래량이 커도 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 0), snap(0, 1.01, 400_000)], AVG, NOW)).toBeNull();
  });

  it("거래량만 폭증(가격 보합)은 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 0), snap(0, 1.0, 400_000)], AVG, NOW)).toBeNull();
  });

  it("가격은 올랐지만 거래량 배율 미달이면 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 0), snap(0, 1.05, 10_000)], AVG, NOW)).toBeNull();
  });

  it("이력 10분 미만이면 미감지", () => {
    expect(judgeSpike([snap(5, 1.0, 0), snap(0, 1.1, 400_000)], AVG, NOW)).toBeNull();
  });

  it("누적거래량 감소(일자 리셋)면 vol_ratio 없음 → 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 900_000), snap(0, 1.05, 100)], AVG, NOW)).toBeNull();
  });
});

describe("judgeSpike — 장외·유동성", () => {
  it("프리마켓 +5% 이상은 거래량 없이 감지", () => {
    const v = judgeSpike([snap(15, 2.0, null, "PRE"), snap(0, 2.12, null, "PRE")], 1_000_000, NOW);
    expect(v).not.toBeNull();
    expect(v!.vol_ratio).toBeNull();
    expect(v!.market_state).toBe("PRE");
  });

  it("프리마켓 +4%는 미감지 (장외 임계 5%)", () => {
    expect(judgeSpike([snap(15, 2.0, null, "PRE"), snap(0, 2.08, null, "PRE")], 1_000_000, NOW)).toBeNull();
  });

  it("10일 평균 거래량 미달(초저유동성)은 무조건 미감지", () => {
    const v = judgeSpike(
      [snap(15, 1.0, 0, "REGULAR"), snap(0, 1.5, 400_000, "REGULAR")],
      SPIKE.MIN_AVG_VOL - 1, NOW);
    expect(v).toBeNull();
  });

  it("avg_vol_10d 미상(null)이면 미감지", () => {
    expect(judgeSpike([snap(15, 2.0, null, "PRE"), snap(0, 2.2, null, "PRE")], null, NOW)).toBeNull();
  });
});

describe("isMarketWindow", () => {
  // ET 기준 검증 — Date는 UTC로 만든다. 2026-07-15는 수요일, EDT(UTC-4).
  it("평일 정규장(ET 10:00)은 true", () => {
    expect(isMarketWindow(new Date("2026-07-15T14:00:00Z"))).toBe(true);
  });
  it("평일 프리마켓(ET 4:30)은 true", () => {
    expect(isMarketWindow(new Date("2026-07-15T08:30:00Z"))).toBe(true);
  });
  it("평일 새벽(ET 3:00)은 false", () => {
    expect(isMarketWindow(new Date("2026-07-15T07:00:00Z"))).toBe(false);
  });
  it("평일 애프터 종료 후(ET 20:30)은 false", () => {
    expect(isMarketWindow(new Date("2026-07-16T00:30:00Z"))).toBe(false);
  });
  it("토요일(ET)은 false", () => {
    expect(isMarketWindow(new Date("2026-07-18T14:00:00Z"))).toBe(false);
  });
});

import { recordAlert, getAlerts, markAlerted, underCooldown, _resetSpikeState } from "./spike";
import type { SpikeAlert } from "./spike";

const mkAlert = (ticker: string, detectedAtMs: number): SpikeAlert => ({
  ticker, name: null, detected_at: Math.floor(detectedAtMs / 1000),
  price: 1, change_pct: 5, vol_ratio: 6, market_state: "REGULAR",
  news: "none", news_title: null, news_url: null, last_price: 1, since_pct: 0,
});

describe("알림 이력 관리", () => {
  it("최신순으로 쌓이고 48시간 지난 건 제거", () => {
    _resetSpikeState();
    const now = Date.now();
    recordAlert(mkAlert("OLD", now - 49 * 3600_000), now);
    recordAlert(mkAlert("A", now - 3600_000), now);
    recordAlert(mkAlert("B", now), now);
    const { alerts } = getAlerts();
    expect(alerts.map(a => a.ticker)).toEqual(["B", "A"]);
  });

  it("최대 건수 초과 시 오래된 것부터 버림", () => {
    _resetSpikeState();
    const now = Date.now();
    // 실제 폴러처럼 시간순(오래된 것 먼저)으로 기록 — T204가 가장 오래됨
    for (let i = 204; i >= 0; i--) recordAlert(mkAlert(`T${i}`, now - i * 1000), now);
    expect(getAlerts().alerts.length).toBe(200);
    expect(getAlerts().alerts[0].ticker).toBe("T0"); // 가장 최근이 맨 앞
  });
});

describe("쿨다운", () => {
  it("markAlerted 후 60분 내 재감지 금지, 지나면 허용", () => {
    _resetSpikeState();
    const now = Date.now();
    expect(underCooldown("ABC", now)).toBe(false);
    markAlerted("ABC", now);
    expect(underCooldown("ABC", now + SPIKE.COOLDOWN_MS - 1)).toBe(true);
    expect(underCooldown("ABC", now + SPIKE.COOLDOWN_MS)).toBe(false);
    expect(underCooldown("XYZ", now)).toBe(false); // 다른 티커는 무관
  });
});
