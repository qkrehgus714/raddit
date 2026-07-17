import { describe, expect, it } from "vitest";
import { parseSpikeQuote } from "./upstream";

describe("parseSpikeQuote", () => {
  it("정규장: regularMarket 필드만 채우고 ext_price는 null", () => {
    const q = parseSpikeQuote({
      marketState: "REGULAR", regularMarketPrice: 3.21, regularMarketVolume: 1_200_000,
      averageDailyVolume10Day: 800_000, shortName: "Acme Inc.",
      preMarketPrice: 3.05, postMarketPrice: 3.3,
    });
    expect(q).toEqual({
      price: 3.21, ext_price: null, volume: 1_200_000,
      avg_vol_10d: 800_000, market_state: "REGULAR", name: "Acme Inc.",
    });
  });

  it("프리마켓: preMarketPrice가 ext_price", () => {
    const q = parseSpikeQuote({ marketState: "PRE", regularMarketPrice: 3.0, preMarketPrice: 3.4 });
    expect(q.ext_price).toBe(3.4);
  });

  it("애프터(POST·POSTPOST·CLOSED): postMarketPrice가 ext_price", () => {
    for (const state of ["POST", "POSTPOST", "CLOSED"]) {
      const q = parseSpikeQuote({ marketState: state, regularMarketPrice: 3.0, postMarketPrice: 2.8 });
      expect(q.ext_price).toBe(2.8);
    }
  });

  it("필드 결손은 전부 null", () => {
    expect(parseSpikeQuote({})).toEqual({
      price: null, ext_price: null, volume: null,
      avg_vol_10d: null, market_state: null, name: null,
    });
  });
});
