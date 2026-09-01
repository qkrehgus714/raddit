import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb, closeDb, isDbReady, loadSqlite, type SqliteModule } from "./db";

/**
 * db.ts 의 계약은 하나다: **앱을 죽이지 않는다.**
 *
 * 수집기는 부가 기능이므로 저장소를 쓸 수 없으면 조용히 비활성화되고 raddit 본체는
 * 정상 동작해야 한다. 그래서 이 파일은 "열리는 경우"보다 **"열리지 않는 경우"** 를
 * 더 많이 검증한다.
 *
 * node:sqlite 는 22.13.0 미만에서 --experimental-sqlite 플래그가 필요해 import 자체가
 * 실패할 수 있다. db.ts → history.ts → middleware.ts 로 이어지므로 그것이 예외로
 * 올라오면 **모든 요청이 500** 이 된다. 그 경로를 여기서 못 박는다.
 */

const ORIGINAL_PATH = process.env.RADDIT_DB_PATH;

beforeEach(() => {
  closeDb();
  process.env.RADDIT_DB_PATH = ":memory:";
  vi.restoreAllMocks();
});

afterEach(() => {
  closeDb();
  if (ORIGINAL_PATH === undefined) delete process.env.RADDIT_DB_PATH;
  else process.env.RADDIT_DB_PATH = ORIGINAL_PATH;
});

describe("node:sqlite 를 쓸 수 없을 때", () => {
  const noSqlite = (): SqliteModule | null => null;

  it("던지지 않고 null 을 돌려준다", () => {
    expect(() => getDb(noSqlite)).not.toThrow();
    expect(getDb(noSqlite)).toBeNull();
  });

  it("isDbReady 가 false 다", () => {
    expect(isDbReady(noSqlite)).toBe(false);
  });

  it("경고를 한 번만 남긴다 — 매 주기 로그를 채우지 않게", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getDb(noSqlite);
    getDb(noSqlite);
    getDb(noSqlite);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("경고 문구가 원인을 짚는다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getDb(noSqlite);
    expect(warn.mock.calls[0]!.join(" ")).toMatch(/node:sqlite/);
  });
});

describe("생성자가 던질 때 (경로에 쓸 수 없음 등)", () => {
  const throwing = (): SqliteModule => ({
    DatabaseSync: class {
      constructor() { throw new Error("EACCES"); }
    } as unknown as SqliteModule["DatabaseSync"],
  });

  it("던지지 않고 null 을 돌려준다", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => getDb(throwing)).not.toThrow();
    expect(getDb(throwing)).toBeNull();
  });

  it("한 번 실패하면 다시 열지 않는다", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const counting = () => { calls++; return throwing(); };
    getDb(counting);
    getDb(counting);
    getDb(counting);
    expect(calls).toBe(1);
  });
});

describe("정상 동작", () => {
  it("실제 node:sqlite 로 열린다 (이 런타임에서 사용 가능하면)", () => {
    const mod = loadSqlite();
    // 이 런타임이 node:sqlite 를 못 쓰면 검증할 것이 없다 — 위 블록이 그 경우를 덮는다
    if (mod == null) return;
    const db = getDb();
    expect(db).not.toBeNull();
    expect(isDbReady()).toBe(true);
  });

  it("스키마가 만들어진다", () => {
    if (loadSqlite() == null) return;
    const db = getDb()!;
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all().map((r: any) => r.name);
    expect(names).toContain("mention_snap");
    expect(names).toContain("quote_snap");
  });

  it("같은 핸들을 재사용한다", () => {
    if (loadSqlite() == null) return;
    expect(getDb()).toBe(getDb());
  });

  // 닫힌 핸들은 건드리면 "database is not open" 으로 던지므로 이전 핸들과 동일성을
  // 비교하지 않는다. 확인할 성질은 "새로 열려서 실제로 쓸 수 있다" 이다.
  it("closeDb 후에는 다시 열어 쓸 수 있다", () => {
    if (loadSqlite() == null) return;
    getDb();
    closeDb();
    const second = getDb();
    expect(second).not.toBeNull();
    expect(() => second!.prepare("SELECT 1").get()).not.toThrow();
  });
});

describe("loadSqlite", () => {
  it("던지지 않는다 — 런타임에 없어도 null 이어야 한다", () => {
    expect(() => loadSqlite()).not.toThrow();
  });

  it("쓸 수 있으면 DatabaseSync 를 내놓는다", () => {
    const mod = loadSqlite();
    if (mod == null) return;
    expect(typeof mod.DatabaseSync).toBe("function");
  });
});
