import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";
import { apeWisdomCryptoTicker, fetchMentions, fetchNews } from "./upstream";

// 크립토 시장 (#93) — ApeWisdom "BTC.X" → Yahoo "BTC-USD" 변환 및
// 뉴스/레딧 검색어에서 "-USD" 접미사를 뗀 원심볼 사용.
describe("apeWisdomCryptoTicker", () => {
  it("ApeWisdom 크립토 티커(.X 접미사)를 Yahoo 심볼(-USD)로 변환", () => {
    expect(apeWisdomCryptoTicker("BTC.X")).toBe("BTC-USD");
    expect(apeWisdomCryptoTicker("ETH.X")).toBe("ETH-USD");
  });

  it("대소문자 구분 없이 .x 접미사도 변환", () => {
    expect(apeWisdomCryptoTicker("doge.x")).toBe("doge-USD");
  });

  it(".X 접미사가 없으면 그대로 반환", () => {
    expect(apeWisdomCryptoTicker("BTC")).toBe("BTC");
  });

  it("문자열 끝이 아닌 X는 변환하지 않음 (접미사만 매치)", () => {
    expect(apeWisdomCryptoTicker("XLM.XA")).toBe("XLM.XA");
  });
});

describe("fetchMentions — market 파라미터", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("market 기본값(stocks)은 티커를 변환하지 않음", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [{ rank: 1, ticker: "AAPL", mentions: 10, upvotes: 1 }], pages: 1 }),
      })),
    );

    const results = await fetchMentions("all-stocks");

    expect(results[0].ticker).toBe("AAPL");
  });

  it("market='crypto'는 .X 티커를 -USD로 변환하고 mentions 내림차순 정렬을 유지한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          results: [
            { rank: 1, ticker: "BTC.X", mentions: 10, upvotes: 1 },
            { rank: 2, ticker: "ETH.X", mentions: 20, upvotes: 1 },
          ],
          pages: 1,
        }),
      })),
    );

    const results = await fetchMentions("all-crypto", "crypto");

    expect(results.map((r) => r.ticker)).toEqual(["ETH-USD", "BTC-USD"]);
  });
});

describe("fetchNews — 크립토 티커(-USD 접미사) 검색어 정규화", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("-USD 접미사를 뗀 원심볼로 뉴스를 검색한다", async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({ news: [] }) }));
    vi.stubGlobal("fetch", mockFetch);

    await fetchNews("BTC-USD");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`q=${encodeURIComponent("BTC")}`);
    expect(url).not.toContain(encodeURIComponent("BTC-USD"));
  });

  it("일반 주식 티커는 그대로 검색어로 사용한다", async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({ news: [] }) }));
    vi.stubGlobal("fetch", mockFetch);

    await fetchNews("AAPL");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`q=${encodeURIComponent("AAPL")}`);
  });
});

describe("fetchRedditPosts — 크립토 티커 검색어 정규화", () => {
  // REDDIT_RPC_URL은 모듈 최상단에서 한 번만 읽힌다 — env를 설정한 뒤
  // 모듈 캐시를 비우고 다시 import해야 반영된다.
  let freshUp: typeof import("./upstream");

  beforeAll(async () => {
    process.env.REDDIT_RPC_URL = "https://reddit-rpc.example.com";
    vi.resetModules();
    freshUp = await import("./upstream");
  });

  afterAll(() => {
    delete process.env.REDDIT_RPC_URL;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("-USD 접미사를 뗀 원심볼로 레딧 게시물을 검색한다", async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [] }) }));
    vi.stubGlobal("fetch", mockFetch);

    await freshUp.fetchRedditPosts("ETH-USD");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`ticker=${encodeURIComponent("ETH")}`);
  });

  it("일반 주식 티커는 그대로 검색어로 사용한다", async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [] }) }));
    vi.stubGlobal("fetch", mockFetch);

    await freshUp.fetchRedditPosts("GME");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`ticker=${encodeURIComponent("GME")}`);
  });
});