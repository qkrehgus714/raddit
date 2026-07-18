import { describe, expect, it } from "vitest";
import { isCryptoTicker } from "./Dashboard";

// 시장 토글 (#93) — Yahoo 크립토 심볼("BTC-USD")과 일반 주식 티커를 구분해
// 공매도/펀더멘털 패널(주식 전용) 노출 여부를 결정하는 데 쓰인다.
describe("isCryptoTicker", () => {
  it("-USD 접미사가 있으면 크립토 티커로 판정", () => {
    expect(isCryptoTicker("BTC-USD")).toBe(true);
    expect(isCryptoTicker("ETH-USD")).toBe(true);
  });

  it("-USD 접미사가 없으면 일반 주식 티커로 판정", () => {
    expect(isCryptoTicker("AAPL")).toBe(false);
    expect(isCryptoTicker("TSLA")).toBe(false);
  });

  it("대소문자 구분 — 소문자 usd 는 매치하지 않음", () => {
    expect(isCryptoTicker("BTC-usd")).toBe(false);
  });

  it("USD가 접미사가 아니면 매치하지 않음", () => {
    expect(isCryptoTicker("USD-BTC")).toBe(false); // 접두사
    expect(isCryptoTicker("BTCUSD")).toBe(false);  // 하이픈 없음
  });

  it("빈 문자열은 false", () => {
    expect(isCryptoTicker("")).toBe(false);
  });
});