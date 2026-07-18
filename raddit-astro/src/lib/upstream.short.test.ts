import { describe, expect, it } from "vitest";
import { parseShortInterest, finraDateCandidates, parseFinraShortVolume } from "./upstream";

// Yahoo v10 quoteSummary 응답 축약 헬퍼
const yahooRes = (ks: any) => ({ quoteSummary: { result: [{ defaultKeyStatistics: ks }] } });

describe("parseShortInterest", () => {
  it("정상 응답 — 모든 필드 추출, 비율 필드는 % 환산", () => {
    const si = parseShortInterest(yahooRes({
      sharesShort: { raw: 1_000_000 },
      sharesShortPriorMonth: { raw: 800_000 },
      shortRatio: { raw: 3.21 },
      shortPercentOfFloat: { raw: 0.1034 },
      sharesPercentSharesOut: { raw: 0.0452 },
      dateShortInterest: { raw: 1_751_241_600 },
    }));
    expect(si).toEqual({
      shares_short: 1_000_000,
      shares_short_prior: 800_000,
      short_ratio: 3.21,
      short_pct_float: 10.34,
      short_pct_out: 4.52,
      date_short_interest: 1_751_241_600,
    });
  });

  it("결손 필드는 null (페니주식 — 비율 필드 없음)", () => {
    const si = parseShortInterest(yahooRes({ sharesShort: { raw: 5000 } }));
    expect(si.shares_short).toBe(5000);
    expect(si.short_pct_float).toBeNull();
    expect(si.short_pct_out).toBeNull();
    expect(si.short_ratio).toBeNull();
    expect(si.shares_short_prior).toBeNull();
    expect(si.date_short_interest).toBeNull();
  });

  it("빈 응답·result 없음 — 전 필드 null", () => {
    for (const raw of [null, {}, { quoteSummary: { result: [] } }]) {
      const si = parseShortInterest(raw);
      expect(si).toEqual({
        shares_short: null, shares_short_prior: null, short_ratio: null,
        short_pct_float: null, short_pct_out: null, date_short_interest: null,
      });
    }
  });
});

// 2026-07: 1일(수), 13일(월), 15일(수), 18일(토)
describe("finraDateCandidates", () => {
  it("평일(수) — ET 당일부터 5영업일, 주말 건너뜀 (당일 파일은 저녁 게시 — 없으면 404로 소급)", () => {
    expect(finraDateCandidates(new Date("2026-07-15T14:00:00Z"))).toEqual(
      ["20260715", "20260714", "20260713", "20260710", "20260709"]);
  });

  it("월요일 — 당일 다음은 금요일 파일로 거슬러 올라감", () => {
    expect(finraDateCandidates(new Date("2026-07-13T14:00:00Z"))).toEqual(
      ["20260713", "20260710", "20260709", "20260708", "20260707"]);
  });

  it("일요일 — 직전 금요일부터", () => {
    expect(finraDateCandidates(new Date("2026-07-12T14:00:00Z"))).toEqual(
      ["20260710", "20260709", "20260708", "20260707", "20260706"]);
  });

  it("토요일 — 직전 금요일부터", () => {
    expect(finraDateCandidates(new Date("2026-07-18T14:00:00Z"))[0]).toBe("20260717");
  });

  it("UTC 새벽은 ET 전날로 계산 (수 02:00Z = ET 화 22:00 → 화요일부터)", () => {
    expect(finraDateCandidates(new Date("2026-07-15T02:00:00Z"))[0]).toBe("20260714");
  });
});

describe("parseFinraShortVolume", () => {
  const HEADER = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market";

  it("정상 파일 — 비중 계산·라운딩", () => {
    const map = parseFinraShortVolume(
      `${HEADER}\n20260717|ABCD|373|0|1000|B,Q,N\n20260717|EFGH|1|0|3|Q\n`);
    expect(map.get("ABCD")).toEqual({ short_vol_pct: 37.3, total_volume: 1000 });
    expect(map.get("EFGH")!.short_vol_pct).toBeCloseTo(33.3333, 3);
  });

  it("헤더만 있으면 빈 맵", () => {
    expect(parseFinraShortVolume(`${HEADER}\n`).size).toBe(0);
  });

  it("TotalVolume 0·숫자 아님 행은 제외", () => {
    const map = parseFinraShortVolume(
      `${HEADER}\n20260717|ZERO|10|0|0|Q\n20260717|BAD|x|0|y|Q\n20260717|OK|5|0|10|Q\n`);
    expect(map.size).toBe(1);
    expect(map.get("OK")!.short_vol_pct).toBe(50);
  });
});
