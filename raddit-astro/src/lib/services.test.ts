import { describe, expect, it, vi, beforeEach } from "vitest";
import * as up from "./upstream";
import { getData } from "./services";

// getData(#93) — market 파라미터로 주식/크립토 경로 분기.
// up.* 는 네트워크 호출이므로 전부 mock 처리하고 순수 필터링/분기 로직만 검증한다.
vi.mock("./upstream", () => ({
  fetchMentions: vi.fn(),
  attachQuotesBatch: vi.fn(),
  attachBidAskBatch: vi.fn(),
  attachThemes: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getData — market='stocks'(기본값)", () => {
  it("가격 상한 이상·비-EQUITY 항목은 제외하고, 호가/테마를 부착한다", async () => {
    const items: any[] = [
      { rank: 1, ticker: "AAA", mentions: 10, upvotes: 1 },
      { rank: 2, ticker: "BBB", mentions: 8, upvotes: 1 }, // 가격 상한 이상 → 제외
      { rank: 3, ticker: "CCC", mentions: 6, upvotes: 1 }, // 비-EQUITY(페니모드) → 제외
    ];
    vi.mocked(up.fetchMentions).mockResolvedValue(items);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      its[0].quote = { price: 3, type: "EQUITY" };
      its[1].quote = { price: 10, type: "EQUITY" };
      its[2].quote = { price: 2, type: "ETF" };
    });

    const result = await getData("svc-stocks-basic", 5, 0);

    expect(result.items.map((i: any) => i.ticker)).toEqual(["AAA"]);
    expect(result.scanned).toBe(3);
    expect(result.filter).toBe("svc-stocks-basic");
    expect(result.max_price).toBe(5);
    expect(up.attachBidAskBatch).toHaveBeenCalledTimes(1);
    expect(up.attachThemes).toHaveBeenCalledTimes(1);
  });

  it("market 인자를 생략하면 기본값 'stocks'로 동작한다", async () => {
    vi.mocked(up.fetchMentions).mockResolvedValue([
      { rank: 1, ticker: "DDD", mentions: 10, upvotes: 1 } as any,
    ]);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      its[0].quote = { price: 1, type: "EQUITY" };
    });

    await getData("svc-stocks-default-market", 5, 0);

    expect(up.fetchMentions).toHaveBeenCalledWith("svc-stocks-default-market", "stocks");
  });

  it("maxPrice=0(가격 필터 없음)이면 EQUITY 여부와 상관없이 시세만 있으면 통과", async () => {
    vi.mocked(up.fetchMentions).mockResolvedValue([
      { rank: 1, ticker: "SOXS", mentions: 10, upvotes: 1 } as any,
    ]);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      its[0].quote = { price: 500, type: "ETF" };
    });

    const result = await getData("svc-stocks-nolimit", 0, 0);

    expect(result.items.map((i: any) => i.ticker)).toEqual(["SOXS"]);
  });

  it("minMentions 미달 항목은 시세 조회 이전에 제외된다 (scanned에도 반영)", async () => {
    vi.mocked(up.fetchMentions).mockResolvedValue([
      { rank: 1, ticker: "LOW", mentions: 1, upvotes: 1 } as any,
      { rank: 2, ticker: "HIGH", mentions: 5, upvotes: 1 } as any,
    ]);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      for (const it of its) it.quote = { price: 1, type: "EQUITY" };
    });

    const result = await getData("svc-stocks-minmentions", 5, 3);

    expect(result.scanned).toBe(1);
    expect(result.items.map((i: any) => i.ticker)).toEqual(["HIGH"]);
  });
});

describe("getData — market='crypto'", () => {
  it("가격 상한·EQUITY 타입 필터를 적용하지 않고, 시세 성공 여부만 확인한다", async () => {
    const items: any[] = [
      { rank: 1, ticker: "BTC-USD", mentions: 10, upvotes: 1 },
      { rank: 2, ticker: "XYZ-USD", mentions: 5, upvotes: 1 }, // 시세 실패 → 제외
    ];
    vi.mocked(up.fetchMentions).mockResolvedValue(items);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      its[0].quote = { price: 65000, type: "CRYPTOCURRENCY" }; // maxPrice=5 지만 크립토는 무시
      its[1].quote = { price: null, type: "CRYPTOCURRENCY" } as any;
    });

    const result = await getData("svc-crypto-basic", 5, 0, "crypto");

    expect(result.items.map((i: any) => i.ticker)).toEqual(["BTC-USD"]);
    expect(up.fetchMentions).toHaveBeenCalledWith("svc-crypto-basic", "crypto");
  });

  it("호가잔량(attachBidAskBatch)·테마(attachThemes)를 호출하지 않는다", async () => {
    vi.mocked(up.fetchMentions).mockResolvedValue([
      { rank: 1, ticker: "ETH-USD", mentions: 10, upvotes: 1 } as any,
    ]);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      its[0].quote = { price: 3000, type: "CRYPTOCURRENCY" };
    });

    await getData("svc-crypto-no-bidask", 5, 0, "crypto");

    expect(up.attachBidAskBatch).not.toHaveBeenCalled();
    expect(up.attachThemes).not.toHaveBeenCalled();
  });
});

describe("getData — 캐시 키에 market 포함", () => {
  it("동일 filter/price/minMentions라도 market이 다르면 별도로 계산된다", async () => {
    let call = 0;
    vi.mocked(up.fetchMentions).mockImplementation(async () => {
      call++;
      return [{ rank: 1, ticker: `T${call}`, mentions: 5, upvotes: 1 } as any];
    });
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      for (const it of its) it.quote = { price: 1, type: "EQUITY" };
    });

    const stocksResult = await getData("svc-cachekey-shared", 5, 0, "stocks");
    const cryptoResult = await getData("svc-cachekey-shared", 5, 0, "crypto");

    expect(up.fetchMentions).toHaveBeenCalledTimes(2);
    expect(stocksResult.items[0].ticker).not.toBe(cryptoResult.items[0].ticker);
  });

  it("동일 market/filter/price/minMentions 재호출은 캐시를 재사용한다 (fetchMentions 1회만)", async () => {
    vi.mocked(up.fetchMentions).mockResolvedValue([
      { rank: 1, ticker: "CACHED", mentions: 5, upvotes: 1 } as any,
    ]);
    vi.mocked(up.attachQuotesBatch).mockImplementation(async (its: any[]) => {
      for (const it of its) it.quote = { price: 1, type: "EQUITY" };
    });

    await getData("svc-cachekey-reuse", 5, 0, "stocks");
    await getData("svc-cachekey-reuse", 5, 0, "stocks");

    expect(up.fetchMentions).toHaveBeenCalledTimes(1);
  });
});