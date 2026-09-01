import { describe, expect, it } from "vitest";
import { parseBidAsk } from "./upstream";

/**
 * 대시보드 "호가" 컬럼이 쓰는 파서. parseSpikeQuote 와 같은 야후 응답을 읽으므로
 * **0 을 다루는 방식도 같아야 한다.** 한쪽만 고치면 같은 종목이 화면과 이력에서
 * 다르게 보인다.
 */
describe("parseBidAsk", () => {
  it("정상 호가를 그대로 싣고 매수 비중을 계산한다", () => {
    expect(parseBidAsk({ bid: 3.2, ask: 3.22, bidSize: 300, askSize: 100 })).toEqual({
      bid: 3.2, ask: 3.22, bid_size: 300, ask_size: 100, buy_ratio_pct: 75,
    });
  });

  it("필드가 없으면 전부 null", () => {
    expect(parseBidAsk({})).toEqual({
      bid: null, ask: null, bid_size: null, ask_size: null, buy_ratio_pct: null,
    });
  });

  describe("0 이하 호가", () => {
    it("0 은 null 로 바꾼다", () => {
      expect(parseBidAsk({ bid: 0, ask: 0 })).toMatchObject({ bid: null, ask: null });
    });

    it("한쪽만 0 이어도 그쪽만 null", () => {
      expect(parseBidAsk({ bid: 269.5, ask: 0 })).toMatchObject({ bid: 269.5, ask: null });
    });

    it("음수·비유한값도 null", () => {
      expect(parseBidAsk({ bid: -1, ask: NaN })).toMatchObject({ bid: null, ask: null });
    });

    // 매수 비중은 잔량으로 계산한다 — 가격이 없어도 잔량이 있으면 낼 수 있다.
    it("가격이 0 이어도 잔량 기반 매수 비중은 그대로 낸다", () => {
      expect(parseBidAsk({ bid: 0, ask: 0, bidSize: 160, askSize: 320 })).toEqual({
        bid: null, ask: null, bid_size: 160, ask_size: 320, buy_ratio_pct: 33.3333,
      });
    });
  });

  it("잔량이 둘 다 0 이면 매수 비중은 null (0 으로 나누지 않는다)", () => {
    expect(parseBidAsk({ bid: 1, ask: 2, bidSize: 0, askSize: 0 }).buy_ratio_pct).toBeNull();
  });
});
