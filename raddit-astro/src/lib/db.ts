/**
 * 이력 저장소 (#112) — 언급·시세 스냅샷을 담는 SQLite 파일.
 *
 * 저장소를 아는 유일한 파일이다. 다른 모듈은 "행을 넣는다"만 알고 파일 경로도
 * SQLite도 모른다. 나중에 다른 엔진으로 갈아타도 여기만 바뀐다.
 *
 * 원칙: **앱을 죽이지 않는다.** 수집기는 부가 기능이므로, 볼륨이 없거나 경로에
 * 쓸 수 없으면 조용히 비활성화되고 raddit 본체는 정상 동작해야 한다. 그래서
 * 열기 실패는 예외가 아니라 null 이다.
 *
 * 의존성을 늘리지 않으려고 Node 내장 node:sqlite 를 쓴다 (Node 22.5+).
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = "./data/raddit.db";

/**
 * 스키마. 마이그레이션 도구는 두지 않는다 — 테이블 두 개짜리에는 과하다.
 * 컬럼이 늘면 ALTER TABLE 을 한 줄 추가한다.
 *
 * PK 가 (ts, ticker) 인 이유: INSERT OR REPLACE 가 같은 시각·같은 종목을 덮으므로
 * 수집이 두 번 돌아도 행이 늘지 않는다. 인덱스는 반대 순서로 하나 더 두는데,
 * 백테스트 질의가 "이 종목의 시계열"이라 그 방향으로 훑기 때문이다.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS mention_snap (
  ts               INTEGER NOT NULL,
  ticker           TEXT    NOT NULL,
  rank             INTEGER NOT NULL,
  mentions         INTEGER NOT NULL,
  upvotes          INTEGER,
  mentions_24h_ago INTEGER,
  rank_24h_ago     INTEGER,
  PRIMARY KEY (ts, ticker)
);

CREATE TABLE IF NOT EXISTS quote_snap (
  ts             INTEGER NOT NULL,
  ticker         TEXT    NOT NULL,
  price          REAL,
  day_change_pct REAL,
  volume         INTEGER,
  avg_vol_10d    INTEGER,
  market_state   TEXT,
  -- 호가. 체결 모델용 — 현재가로 사고 팔았다고 가정하면 실재하지 않는 스프레드가
  -- 수익으로 잡힌다. 소급해서 구할 수 없으므로 처음부터 같이 쌓는다.
  bid            REAL,
  ask            REAL,
  bid_size       INTEGER,
  ask_size       INTEGER,
  PRIMARY KEY (ts, ticker)
);

CREATE INDEX IF NOT EXISTS idx_mention_ticker ON mention_snap(ticker, ts);
CREATE INDEX IF NOT EXISTS idx_quote_ticker   ON quote_snap(ticker, ts);
`;

let db: DatabaseSync | null = null;
/** 한 번 실패하면 기억한다 — 매 주기 재시도하며 로그를 채우지 않게. */
let openFailed = false;

/** 저장소 핸들. 열 수 없으면 null 을 돌려주고 던지지 않는다. */
export function getDb(): DatabaseSync | null {
  if (db) return db;
  if (openFailed) return null;
  const path = process.env.RADDIT_DB_PATH || DEFAULT_PATH;
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const handle = new DatabaseSync(path);
    // 수집이 도는 동안에도 읽기가 막히지 않게. :memory: 는 WAL 을 지원하지 않는다.
    if (path !== ":memory:") handle.exec("PRAGMA journal_mode = WAL");
    handle.exec(SCHEMA);
    db = handle;
    return db;
  } catch (e) {
    openFailed = true;
    console.warn(`[history] 저장소를 열 수 없어 이력 수집을 건너뜁니다 (${path}):`,
      e instanceof Error ? e.message : e);
    return null;
  }
}

export function isDbReady(): boolean {
  return getDb() != null;
}

/** 핸들을 닫고 상태를 초기화한다 (테스트 · 종료 시). */
export function closeDb(): void {
  try { db?.close(); } catch { /* 이미 닫혔으면 무시 */ }
  db = null;
  openFailed = false;
}
