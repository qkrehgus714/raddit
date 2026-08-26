import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb, isDbReady } from "./db";
import {
  collectOnce, dedupeByTicker, hourBucket, saveMentionSnap, saveQuoteSnap,
  type CollectDeps,
} from "./history";
import type { MentionItem, SpikeQuote } from "./upstream";

const HOUR = 3_600_000;

/** 2026-08-21 13:00:00 UTC */
const H13 = Date.UTC(2026, 7, 21, 13, 0, 0);

/**
 * 절대 열 수 없는 경로 — 부모가 디렉터리가 아니라 파일이다.
 * (없는 드라이브 문자를 쓰면 머신에 따라 매핑돼 있어 열려버린다.)
 */
function unopenablePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "raddit-hist-"));
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "");
  return join(file, "raddit.db");
}

const mention = (ticker: string, rank: number, mentions: number): MentionItem =>
  ({ rank, ticker, mentions, upvotes: mentions * 10, mentions_24h_ago: mentions - 5, rank_24h_ago: rank + 2 });

const quote = (price: number, over: Partial<SpikeQuote> = {}): SpikeQuote => ({
  price, ext_price: null, volume: 1_000, avg_vol_10d: 5_000,
  market_state: "REGULAR", name: "X", day_change_pct: 1.5,
  bid: price - 0.02, ask: price + 0.03, bid_size: 400, ask_size: 700, ...over,
});

beforeEach(() => {
  process.env.RADDIT_DB_PATH = ":memory:";
  closeDb();
});
afterEach(() => {
  closeDb();
  delete process.env.RADDIT_DB_PATH;
});

describe("hourBucket — 정시 내림", () => {
  it("같은 시간대의 어느 순간이든 같은 값", () => {
    expect(hourBucket(H13 + 4_000)).toBe(hourBucket(H13 + HOUR - 1));
  });

  it("정시 epoch sec 로 떨어진다", () => {
    expect(hourBucket(H13 + 57_000)).toBe(H13 / 1000);
  });

  it("다음 시간대는 3600 크다", () => {
    expect(hourBucket(H13 + HOUR) - hourBucket(H13)).toBe(3600);
  });
});

describe("스키마", () => {
  it("두 테이블이 생성된다", () => {
    const db = getDb()!;
    expect(db).not.toBeNull();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r: any) => r.name);
    expect(names).toContain("mention_snap");
    expect(names).toContain("quote_snap");
  });

  it("DB 를 열 수 없으면 null 이고 예외를 던지지 않는다", () => {
    closeDb();
    process.env.RADDIT_DB_PATH = unopenablePath();
    expect(() => getDb()).not.toThrow();
    expect(getDb()).toBeNull();
    expect(isDbReady()).toBe(false);
  });
});

describe("saveMentionSnap", () => {
  it("행을 쓰고 개수를 돌려준다", () => {
    const db = getDb()!;
    const n = saveMentionSnap(db, 1000, [mention("ASTS", 1, 100), mention("GEVO", 2, 50)]);
    expect(n).toBe(2);
    const rows = db.prepare("SELECT * FROM mention_snap ORDER BY rank").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ts: 1000, ticker: "ASTS", rank: 1, mentions: 100, upvotes: 1000 });
    expect(rows[0].mentions_24h_ago).toBe(95);
  });

  it("같은 (ts, ticker) 를 두 번 넣어도 행이 하나 — 재실행 안전", () => {
    const db = getDb()!;
    saveMentionSnap(db, 1000, [mention("ASTS", 1, 100)]);
    saveMentionSnap(db, 1000, [mention("ASTS", 1, 140)]);
    const rows = db.prepare("SELECT * FROM mention_snap").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].mentions).toBe(140); // 나중 값으로 덮인다
  });

  it("다른 ts 는 별개 행", () => {
    const db = getDb()!;
    saveMentionSnap(db, 1000, [mention("ASTS", 1, 100)]);
    saveMentionSnap(db, 4600, [mention("ASTS", 1, 120)]);
    expect(db.prepare("SELECT COUNT(*) c FROM mention_snap").get()).toMatchObject({ c: 2 });
  });
});

describe("saveQuoteSnap", () => {
  it("행을 쓰고 일간 등락률을 보존한다", () => {
    const db = getDb()!;
    const n = saveQuoteSnap(db, 1000, new Map([["ASTS", quote(4.12)]]));
    expect(n).toBe(1);
    const row = db.prepare("SELECT * FROM quote_snap").get() as any;
    expect(row).toMatchObject({ ts: 1000, ticker: "ASTS", price: 4.12, market_state: "REGULAR" });
    expect(row.day_change_pct).toBeCloseTo(1.5, 5);
  });

  it("같은 (ts, ticker) 재삽입은 덮어쓴다", () => {
    const db = getDb()!;
    saveQuoteSnap(db, 1000, new Map([["ASTS", quote(4.12)]]));
    saveQuoteSnap(db, 1000, new Map([["ASTS", quote(4.55)]]));
    const rows = db.prepare("SELECT * FROM quote_snap").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBeCloseTo(4.55, 5);
  });

  it("호가를 저장한다 — 체결 모델이 스프레드를 알아야 한다", () => {
    const db = getDb()!;
    saveQuoteSnap(db, 1000, new Map([["ASTS", quote(4.12)]]));
    const row = db.prepare("SELECT bid, ask, bid_size, ask_size FROM quote_snap").get() as any;
    expect(row.bid).toBeCloseTo(4.10, 5);
    expect(row.ask).toBeCloseTo(4.15, 5);
    expect(row).toMatchObject({ bid_size: 400, ask_size: 700 });
  });

  it("호가가 없는 종목도 가격만 있으면 저장한다 (호가는 null)", () => {
    const db = getDb()!;
    const q = quote(2.0, { bid: null, ask: null, bid_size: null, ask_size: null });
    expect(saveQuoteSnap(db, 1000, new Map([["NOBID", q]]))).toBe(1);
    const row = db.prepare("SELECT * FROM quote_snap").get() as any;
    expect(row.bid).toBeNull();
    expect(row.price).toBeCloseTo(2.0, 5);
  });

  it("가격이 없는 종목은 건너뛴다", () => {
    const db = getDb()!;
    const q = { ...quote(1), price: null } as SpikeQuote;
    expect(saveQuoteSnap(db, 1000, new Map([["NOPE", q]]))).toBe(0);
  });
});

describe("dedupeByTicker — ApeWisdom 이 페이지 간 중복을 준다", () => {
  it("먼저 나온 쪽(언급 많은 쪽)을 남긴다", () => {
    const out = dedupeByTicker([
      mention("CRWV", 1, 300), mention("ASTS", 2, 200), mention("CRWV", 9, 120),
    ]);
    expect(out.map(x => x.ticker)).toEqual(["CRWV", "ASTS"]);
    expect(out[0].mentions).toBe(300);
  });

  it("중복이 없으면 그대로", () => {
    const src = [mention("A", 1, 10), mention("B", 2, 5)];
    expect(dedupeByTicker(src)).toEqual(src);
  });
});

describe("collectOnce", () => {
  const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
    fetchMentions: async () => [mention("ASTS", 1, 100), mention("GEVO", 2, 50)],
    fetchSpikeQuotes: async () => new Map([["ASTS", quote(4.12)], ["GEVO", quote(1.37)]]),
    ...over,
  });

  it("언급과 시세를 같은 ts 로 저장한다", async () => {
    const r = await collectOnce(deps(), H13 + 12_000);
    expect(r).toMatchObject({ ts: H13 / 1000, mentions: 2, quotes: 2 });
    const db = getDb()!;
    const m = db.prepare("SELECT ts FROM mention_snap").all() as any[];
    const q = db.prepare("SELECT ts FROM quote_snap").all() as any[];
    expect(m[0].ts).toBe(q[0].ts);
  });

  it("시세 조회가 실패해도 언급은 남는다 — 들어간 만큼 남는다", async () => {
    const r = await collectOnce(
      deps({ fetchSpikeQuotes: async () => { throw new Error("yahoo down"); } }), H13);
    expect(r.mentions).toBe(2);
    expect(r.quotes).toBe(0);
    const db = getDb()!;
    expect(db.prepare("SELECT COUNT(*) c FROM mention_snap").get()).toMatchObject({ c: 2 });
    expect(db.prepare("SELECT COUNT(*) c FROM quote_snap").get()).toMatchObject({ c: 0 });
  });

  it("언급 조회가 실패하면 던진다 — 폴러가 받아 다음 주기에 재시도", async () => {
    await expect(collectOnce(
      deps({ fetchMentions: async () => { throw new Error("apewisdom down"); } }), H13),
    ).rejects.toThrow("apewisdom down");
  });

  it("상위 TOP_N 개까지만 저장한다", async () => {
    const many = Array.from({ length: 400 }, (_, i) => mention(`T${i}`, i + 1, 400 - i));
    const r = await collectOnce(deps({ fetchMentions: async () => many }), H13);
    expect(r.mentions).toBe(200);
  });

  it("중복 티커가 와도 보고한 수와 저장된 행 수가 일치한다", async () => {
    // 실제로 겪은 상황: 상위 200 안에 같은 티커가 두 번 들어와 196행만 남았다
    const many = Array.from({ length: 400 }, (_, i) => mention(`T${i}`, i + 1, 400 - i));
    many.splice(50, 0, mention("T3", 51, 120), mention("T7", 52, 110)); // 중복 2건 주입
    const r = await collectOnce(deps({ fetchMentions: async () => many }), H13);
    const db = getDb()!;
    const rows = db.prepare("SELECT COUNT(*) c FROM mention_snap").get() as any;
    expect(r.mentions).toBe(200);
    expect(rows.c).toBe(200); // 중복을 미리 걸렀으므로 어긋나지 않는다
  });

  it("DB 를 못 열면 조용히 건너뛴다 — 예외 없음", async () => {
    closeDb();
    process.env.RADDIT_DB_PATH = unopenablePath();
    const r = await collectOnce(deps(), H13);
    expect(r).toMatchObject({ ts: H13 / 1000, mentions: 0, quotes: 0 });
  });
});
