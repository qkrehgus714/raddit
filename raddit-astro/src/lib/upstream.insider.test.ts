import { describe, expect, it } from "vitest";
import { parseInsider } from "./upstream";

// Yahoo v10 quoteSummary(insiderTransactions, netSharePurchaseActivity) 응답 축약 헬퍼
const yahooRes = (result: any) => ({ quoteSummary: { result: [result] } });

const tx = (filerName: string, date: number, extra: any = {}) => ({
  filerName,
  filerRelation: extra.relation ?? "Officer",
  transactionText: extra.text ?? "Sale at price 1.00 per share.",
  shares: extra.shares != null ? { raw: extra.shares } : undefined,
  value: extra.value != null ? { raw: extra.value } : undefined,
  startDate: { raw: date },
});

describe("parseInsider", () => {
  it("정상 응답 — 6개월 요약(비율 % 환산) + 최근 거래", () => {
    const res = parseInsider(yahooRes({
      netSharePurchaseActivity: {
        period: "6m",
        buyInfoCount: { raw: 4 },
        buyInfoShares: { raw: 189_000 },
        sellInfoCount: { raw: 6 },
        sellInfoShares: { raw: 2_689_000 },
        netInfoShares: { raw: -2_500_000 },
        netPercentInsiderShares: { raw: -0.0321 },
        totalInsiderShares: { raw: 12_000_000 },
      },
      insiderTransactions: {
        transactions: [
          tx("Jane CFO", 1_749_000_000, { shares: 2605, value: 1_047_731, text: "Sale at price 402.20 per share." }),
        ],
      },
    }));
    expect(res.activity).toEqual({
      period: "6m",
      buy_count: 4,
      buy_shares: 189_000,
      sell_count: 6,
      sell_shares: 2_689_000,
      net_shares: -2_500_000,
      net_pct_shares: -3.21,
      total_insider_shares: 12_000_000,
    });
    expect(res.transactions).toEqual([{
      filer_name: "Jane CFO",
      relation: "Officer",
      text: "Sale at price 402.20 per share.",
      shares: 2605,
      value: 1_047_731,
      date: 1_749_000_000,
    }]);
  });

  it("거래 5건 초과 — 최신순 정렬 후 5건으로 자름", () => {
    const transactions = Array.from({ length: 7 }, (_, i) => tx(`Filer${i}`, 1000 + i, { shares: i }));
    const res = parseInsider(yahooRes({ insiderTransactions: { transactions } }));
    expect(res.transactions).toHaveLength(5);
    expect(res.transactions.map(t => t.date)).toEqual([1006, 1005, 1004, 1003, 1002]);
  });

  it("결손 필드 — netSharePurchaseActivity 없으면 activity null, transactions 없으면 빈 배열", () => {
    expect(parseInsider(yahooRes({}))).toEqual({ activity: null, transactions: [] });
    expect(parseInsider(yahooRes({ insiderTransactions: {} }))).toEqual({ activity: null, transactions: [] });
  });

  it("거래 개별 필드 결손 허용 (페니주식 — shares/value 없음)", () => {
    const res = parseInsider(yahooRes({
      insiderTransactions: { transactions: [{ filerName: "John Doe", startDate: { raw: 100 } }] },
    }));
    expect(res.transactions).toEqual([{
      filer_name: "John Doe", relation: null, text: null, shares: null, value: null, date: 100,
    }]);
  });

  it("빈 응답·result 없음 — 전 필드 null/빈배열", () => {
    for (const raw of [null, {}, { quoteSummary: { result: [] } }]) {
      expect(parseInsider(raw)).toEqual({ activity: null, transactions: [] });
    }
  });
});
