/**
 * 언급·시세 이력 수집 (#112) — 자동매매 0단계.
 *
 * ApeWisdom 은 현재 스냅샷만 주고 raddit 은 그것을 어디에도 저장하지 않아,
 * "언급이 튄 다음 날 주가가 어떻게 됐나"를 확인할 데이터가 없다. 데이터는
 * 기다린 만큼만 쌓이므로 전략 정의보다 먼저 켠다.
 *
 * 저장 계층은 db.ts 가 맡는다. 이 파일은 업스트림과 스키마를 잇기만 한다.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import * as up from "./upstream";
import type { MentionItem, SpikeQuote } from "./upstream";

export const HISTORY = {
  POLL_MS: 3_600_000,       // 1시간 — ApeWisdom 집계 구간이 수시간 단위라 그보다 짧게 돌 이유가 없다
  TOP_N: 200,               // 시각당 저장할 상위 종목 수
  START_DELAY_MS: 10_000,   // 기동 직후 요청 처리 방해 방지 (급등 폴러 5초와 겹치지 않게)
  FAIL_BACKOFF_MS: 600_000, // 연속 실패 시 10분
  FAIL_STREAK_MAX: 3,
} as const;

/**
 * 수집 시각을 정시로 내린 epoch sec.
 *
 * 13:00:04 에 돌든 13:00:57 에 돌든 같은 값이어야 "t시점 언급 → t+24h 가격" 조인이
 * 시각 오차 없이 붙고, 재실행 멱등성도 여기서 나온다.
 */
export function hourBucket(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 3_600_000) * 3600;
}

/** 언급 스냅샷 저장. 돌려주는 값은 쓴 행 수. */
export function saveMentionSnap(db: DatabaseSync, ts: number, items: MentionItem[]): number {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mention_snap
     (ts, ticker, rank, mentions, upvotes, mentions_24h_ago, rank_24h_ago)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const it of items) {
      stmt.run(ts, it.ticker, it.rank, it.mentions, it.upvotes ?? null,
        it.mentions_24h_ago ?? null, it.rank_24h_ago ?? null);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/** 시세 스냅샷 저장. 가격이 없는 종목은 남길 값이 없으므로 건너뛴다. */
export function saveQuoteSnap(db: DatabaseSync, ts: number, quotes: Map<string, SpikeQuote>): number {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO quote_snap
     (ts, ticker, price, day_change_pct, volume, avg_vol_10d, market_state,
      bid, ask, bid_size, ask_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const [ticker, q] of quotes) {
      if (q.price == null) continue;
      stmt.run(ts, ticker, q.price, q.day_change_pct ?? null, q.volume ?? null,
        q.avg_vol_10d ?? null, q.market_state ?? null,
        q.bid ?? null, q.ask ?? null, q.bid_size ?? null, q.ask_size ?? null);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/** 업스트림 주입점 — 테스트가 실제 네트워크 없이 수집 흐름을 검증할 수 있게. */
export interface CollectDeps {
  fetchMentions: (filter: string) => Promise<MentionItem[]>;
  fetchSpikeQuotes: (tickers: string[]) => Promise<Map<string, SpikeQuote>>;
}

const REAL: CollectDeps = {
  fetchMentions: (filter) => up.fetchMentions(filter),
  fetchSpikeQuotes: (tickers) => up.fetchSpikeQuotes(tickers),
};

export interface CollectResult {
  ts: number;
  mentions: number;
  quotes: number;
}

/**
 * 티커 중복 제거. **ApeWisdom 이 페이지 간에 같은 티커를 중복으로 준다** —
 * 실측(2026-08-21) 상위 200 안에 CRWV·UMAC·GLP·RIVN 이 두 번씩 들어 있었다.
 *
 * 그대로 두면 INSERT OR REPLACE 가 조용히 덮어써서, 중복된 두 행의 언급 수가 다를 때
 * 어느 쪽이 남을지 임의가 된다. 저장 행 수도 시도 횟수와 어긋난다.
 * fetchMentions 가 언급 내림차순으로 정렬해 주므로 먼저 나온 쪽(=언급이 많은 쪽)을 남긴다.
 */
export function dedupeByTicker(items: MentionItem[]): MentionItem[] {
  const seen = new Set<string>();
  const out: MentionItem[] = [];
  for (const it of items) {
    if (seen.has(it.ticker)) continue;
    seen.add(it.ticker);
    out.push(it);
  }
  return out;
}

/**
 * 1회 수집. 언급을 먼저 저장하고 시세를 뒤에 붙인다.
 *
 * 두 저장을 각각 트랜잭션으로 감싸는 이유: 언급과 시세는 출처도 실패 양상도 다르다.
 * ApeWisdom 이 살아 있는데 야후가 죽는 일이 흔하다. 나눠 두면 **들어간 만큼 남는다.**
 * 언급 조회 실패는 그 주기에 남길 게 없다는 뜻이므로 던져서 폴러가 백오프하게 한다.
 */
export async function collectOnce(
  deps: CollectDeps = REAL, nowMs: number = Date.now(),
): Promise<CollectResult> {
  const ts = hourBucket(nowMs);
  const db = getDb();
  if (!db) return { ts, mentions: 0, quotes: 0 };

  const all = await deps.fetchMentions("all-stocks");
  // 자르기 전에 중복을 없앤다 — 나중에 없애면 TOP_N 이 실제로는 그보다 적어진다
  const items = dedupeByTicker(all).slice(0, HISTORY.TOP_N);
  const mentions = saveMentionSnap(db, ts, items);

  let quotes = 0;
  try {
    const map = await deps.fetchSpikeQuotes(items.map(i => i.ticker));
    quotes = saveQuoteSnap(db, ts, map);
  } catch (e) {
    // 시세만 실패 — 언급은 이미 저장됐다. 다음 주기에 다시 시도한다.
    console.warn("[history] 시세 수집 실패 (언급은 저장됨):", e instanceof Error ? e.message : e);
  }
  return { ts, mentions, quotes };
}

// ── 폴링 루프 ──
// ensureSpikeWatch 와 같은 모양을 유지한다. 두 폴러가 다르게 생기면 읽는 사람이
// 매번 둘을 비교해야 한다.

let failStreak = 0;

/** 수집기 기동 — 멱등. 미들웨어가 요청마다 부르지만 globalThis 가드로 1회만. */
export function ensureHistoryCollect(): void {
  const g = globalThis as { __radditHistoryCollect?: boolean };
  if (g.__radditHistoryCollect) return;
  if (process.env.HISTORY_COLLECT === "0") return;
  if (!getDb()) return; // 저장소가 없으면 아예 켜지 않는다 (경고는 getDb 가 이미 남겼다)
  g.__radditHistoryCollect = true;
  console.log("[history] 이력 수집 시작 (1시간 간격)");

  const tick = async () => {
    let delay: number = HISTORY.POLL_MS;
    try {
      const r = await collectOnce();
      failStreak = 0;
      console.log(`[history] ts=${r.ts} 언급 ${r.mentions} · 시세 ${r.quotes}`);
    } catch (e) {
      failStreak++;
      console.error(`[history] 수집 실패 (${failStreak}연속):`, e instanceof Error ? e.message : e);
      if (failStreak >= HISTORY.FAIL_STREAK_MAX) delay = HISTORY.FAIL_BACKOFF_MS;
    }
    setTimeout(tick, delay).unref?.();
  };
  setTimeout(tick, HISTORY.START_DELAY_MS).unref?.();
}
