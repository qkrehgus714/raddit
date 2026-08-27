import { describe, expect, it } from "vitest";
import { parseSpikeQuote } from "./upstream";

describe("parseSpikeQuote", () => {
  it("정규장: regularMarket 필드만 채우고 ext_price는 null", () => {
    const q = parseSpikeQuote({
      marketState: "REGULAR", regularMarketPrice: 3.21, regularMarketVolume: 1_200_000,
      averageDailyVolume10Day: 800_000, shortName: "Acme Inc.",
      preMarketPrice: 3.05, postMarketPrice: 3.3, regularMarketChangePercent: 4.2,
      bid: 3.20, ask: 3.22, bidSize: 500, askSize: 900,
    });
    expect(q).toEqual({
      price: 3.21, ext_price: null, volume: 1_200_000,
      avg_vol_10d: 800_000, market_state: "REGULAR", name: "Acme Inc.",
      day_change_pct: 4.2, bid: 3.20, ask: 3.22, bid_size: 500, ask_size: 900,
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
      avg_vol_10d: null, market_state: null, name: null, day_change_pct: null,
      bid: null, ask: null, bid_size: null, ask_size: null,
    });
  });

  // #112 — 이력·백테스트에는 일간 등락률이 필요하다. 급등 판정의 15분 구간
  // 변화율과는 다른 값이고, 같은 응답에 이미 들어 있어 추가 요청이 없다.
  it("일간 등락률을 그대로 싣는다 (하락도 부호 보존)", () => {
    expect(parseSpikeQuote({ regularMarketChangePercent: -8.1 }).day_change_pct).toBe(-8.1);
    expect(parseSpikeQuote({ regularMarketChangePercent: 0 }).day_change_pct).toBe(0);
  });

  // 야후는 호가가 없을 때 0 을 준다 — 거래량 수백만 주짜리 대형주에도 그렇다
  // (실측 2026-08-27: JPM · MCD · SGOV 가 정규장에 bid 또는 ask 가 0).
  // $0 매수호가는 존재하지 않으므로 0 은 "값 없음"이지 가격이 아니다. 그대로 두면
  // 체결 모델이 공짜로 샀다고 계산하고 스프레드가 음수가 된다.
  describe("0 이하 호가", () => {
    it("0 은 null 로 바꾼다", () => {
      const q = parseSpikeQuote({ bid: 0, ask: 0 });
      expect(q.bid).toBeNull();
      expect(q.ask).toBeNull();
    });

    it("한쪽만 0 이어도 그쪽만 null (반대쪽은 살린다)", () => {
      expect(parseSpikeQuote({ bid: 354.44, ask: 0 })).toMatchObject({ bid: 354.44, ask: null });
      expect(parseSpikeQuote({ bid: 0, ask: 141.74 })).toMatchObject({ bid: null, ask: 141.74 });
    });

    it("음수도 null", () => {
      expect(parseSpikeQuote({ bid: -1, ask: -0.5 })).toMatchObject({ bid: null, ask: null });
    });

    it("숫자가 아니거나 유한하지 않으면 null", () => {
      expect(parseSpikeQuote({ bid: "3.2", ask: NaN })).toMatchObject({ bid: null, ask: null });
      expect(parseSpikeQuote({ bid: Infinity, ask: null })).toMatchObject({ bid: null, ask: null });
    });

    it("정상 호가는 그대로 둔다", () => {
      expect(parseSpikeQuote({ bid: 3.2, ask: 3.22 })).toMatchObject({ bid: 3.2, ask: 3.22 });
    });

    // 잔량은 별개 신호(매수 비중)다. 가격이 없다고 잔량까지 버리지 않는다.
    it("가격이 0 이어도 잔량은 남긴다", () => {
      expect(parseSpikeQuote({ bid: 0, ask: 0, bidSize: 160, askSize: 320 }))
        .toMatchObject({ bid: null, ask: null, bid_size: 160, ask_size: 320 });
    });
  });
});
