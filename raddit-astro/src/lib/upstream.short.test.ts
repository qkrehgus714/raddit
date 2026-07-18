import { describe, expect, it } from "vitest";
import { parseShortInterest } from "./upstream";

// Yahoo v10 quoteSummary 응답 축약 헬퍼
const yahooRes = (ks: any) => ({ quoteSummary: { result: [{ defaultKeyStatistics: ks }] } });

describe("parseShortInterest", () => {
  it("정상 응답 — 모든 필드 추출, shortPercentOfFloat 는 % 환산", () => {
    const si = parseShortInterest(yahooRes({
      sharesShort: { raw: 1_000_000 },
      sharesShortPriorMonth: { raw: 800_000 },
      shortRatio: { raw: 3.21 },
      shortPercentOfFloat: { raw: 0.1034 },
      dateShortInterest: { raw: 1_751_241_600 },
    }));
    expect(si).toEqual({
      shares_short: 1_000_000,
      shares_short_prior: 800_000,
      short_ratio: 3.21,
      short_pct_float: 10.34,
      date_short_interest: 1_751_241_600,
    });
  });

  it("결손 필드는 null (페니주식 — shortPercentOfFloat 없음)", () => {
    const si = parseShortInterest(yahooRes({ sharesShort: { raw: 5000 } }));
    expect(si.shares_short).toBe(5000);
    expect(si.short_pct_float).toBeNull();
    expect(si.short_ratio).toBeNull();
    expect(si.shares_short_prior).toBeNull();
    expect(si.date_short_interest).toBeNull();
  });

  it("빈 응답·result 없음 — 전 필드 null", () => {
    for (const raw of [null, {}, { quoteSummary: { result: [] } }]) {
      const si = parseShortInterest(raw);
      expect(si).toEqual({
        shares_short: null, shares_short_prior: null, short_ratio: null,
        short_pct_float: null, date_short_interest: null,
      });
    }
  });
});
