# 뉴스 선행 급등 실시간 탐지 (#74) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레딧 언급 상위 종목을 서버가 장 시간대에 90초 간격 폴링해 이상 급등을 감지하고, 뉴스 유무와 함께 "⚡ 급등" 이력 뷰에 시간순 기록한다.

**Architecture:** `src/lib/spike.ts`에 감지 엔진(순수 판정 함수 + 인메모리 링버퍼·이력 + 폴링 루프). 폴러는 `src/middleware.ts`에서 첫 요청 시 1회 lazy-start. 시세는 `upstream.ts`에 추가하는 v7 quote 배치 함수로 수집(기존 `attachBidAskBatch`의 crumb 인증·청크 패턴 재사용). `/api/alerts`로 노출하고 `Dashboard.tsx`에 세 번째 viewMode `"alerts"` 추가.

**Tech Stack:** Astro 7 (node standalone) · Solid.js · TypeScript · vitest(신규 도입) · Yahoo Finance v7 quote

**Spec:** `docs/superpowers/specs/2026-07-16-spike-detection-design.md`

## Global Constraints

- 작업 브랜치: `feat/spike-alerts` (이미 생성됨, origin/dev 기반). `main`·`dev` 직접 push 절대 금지.
- 커밋: Conventional Commits + 한국어, body(왜)는 필수, 72자 줄바꿈. 예: `feat(spike): …`
- 커밋 footer에 `Refs #74` (마지막 작업 커밋만 PR에서 `Closes #74`로 연결).
- **Windows 주의: node/npm은 PowerShell에서 안 잡힘 — 모든 npm/node 명령은 Git Bash에서 실행.**
- 모든 npm 명령의 작업 디렉터리는 `raddit-astro/`.
- 감지 임계값은 `SPIKE` 상수 객체에만 존재해야 함 (매직넘버 산재 금지).
- 폴링 사이클의 어떤 실패도 서버 프로세스를 죽이면 안 됨.

---

### Task 1: vitest 도입 + v7 quote 배치 파서·조회 (upstream)

**Files:**
- Modify: `raddit-astro/package.json` (devDep vitest, test 스크립트)
- Modify: `raddit-astro/src/lib/upstream.ts` (parseSpikeQuote, fetchSpikeQuotes 추가 — `attachBidAskBatch` 함수 뒤에)
- Test: `raddit-astro/src/lib/upstream.spike.test.ts`

**Interfaces:**
- Consumes: 기존 `getYahooAuth()`(모듈 내부), `YAHOO_QUOTE_URL(ticker)`, `BROWSER_UA`, `round4()` — 모두 upstream.ts 안에 이미 존재.
- Produces (Task 3이 사용):
  ```ts
  export interface SpikeQuote {
    price: number | null;        // regularMarketPrice
    ext_price: number | null;    // 세션에 따른 pre/postMarket 가격 (없으면 null)
    volume: number | null;       // regularMarketVolume (당일 누적)
    avg_vol_10d: number | null;  // averageDailyVolume10Day
    market_state: string | null; // PRE·REGULAR·POST·POSTPOST·CLOSED
    name: string | null;
  }
  export function parseSpikeQuote(q: any): SpikeQuote;
  export async function fetchSpikeQuotes(tickers: string[], chunkSize?: number): Promise<Map<string, SpikeQuote>>;
  ```

- [ ] **Step 1: vitest 설치 + 스크립트 추가**

Git Bash에서:
```bash
cd raddit-astro && npm install -D vitest
```
`raddit-astro/package.json`의 scripts에 추가:
```json
"test": "vitest run"
```

- [ ] **Step 2: parseSpikeQuote 실패하는 테스트 작성**

`raddit-astro/src/lib/upstream.spike.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseSpikeQuote } from "./upstream";

describe("parseSpikeQuote", () => {
  it("정규장: regularMarket 필드만 채우고 ext_price는 null", () => {
    const q = parseSpikeQuote({
      marketState: "REGULAR", regularMarketPrice: 3.21, regularMarketVolume: 1_200_000,
      averageDailyVolume10Day: 800_000, shortName: "Acme Inc.",
      preMarketPrice: 3.05, postMarketPrice: 3.3,
    });
    expect(q).toEqual({
      price: 3.21, ext_price: null, volume: 1_200_000,
      avg_vol_10d: 800_000, market_state: "REGULAR", name: "Acme Inc.",
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
      avg_vol_10d: null, market_state: null, name: null,
    });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run(Git Bash): `cd raddit-astro && npx vitest run src/lib/upstream.spike.test.ts`
Expected: FAIL — `parseSpikeQuote`가 export되지 않음.

- [ ] **Step 4: 구현 — upstream.ts의 `attachBidAskBatch` 바로 아래에 추가**

```ts
// ── 급등 탐지용 배치 시세 (#74) ──

export interface SpikeQuote {
  price: number | null;        // regularMarketPrice
  ext_price: number | null;    // 세션에 따른 pre/postMarket 가격
  volume: number | null;       // regularMarketVolume (당일 누적)
  avg_vol_10d: number | null;  // averageDailyVolume10Day
  market_state: string | null;
  name: string | null;
}

/** v7 quote 응답 1건 → 급등 감지에 필요한 필드만. 세션에 따라 유효한 장외가 선택. */
export function parseSpikeQuote(q: any): SpikeQuote {
  const state: string | null = q.marketState ?? null;
  let ext: number | null = null;
  if (state === "PRE" && q.preMarketPrice != null) ext = q.preMarketPrice;
  else if (["POST", "POSTPOST", "CLOSED"].includes(state ?? "") && q.postMarketPrice != null) {
    ext = q.postMarketPrice;
  }
  return {
    price: q.regularMarketPrice ?? null,
    ext_price: ext == null ? null : round4(ext),
    volume: q.regularMarketVolume ?? null,
    avg_vol_10d: q.averageDailyVolume10Day ?? null,
    market_state: state,
    name: q.shortName ?? q.longName ?? null,
  };
}

/**
 * 급등 감시 대상 시세를 v7/quote 배치로 조회 (crumb 인증 — attachBidAskBatch와 동일 패턴).
 * 청크 실패는 해당 청크만 누락. crumb 발급 실패 시 빈 Map (폴러가 다음 주기에 재시도).
 */
export async function fetchSpikeQuotes(
  tickers: string[], chunkSize = 60,
): Promise<Map<string, SpikeQuote>> {
  const out = new Map<string, SpikeQuote>();
  if (!tickers.length) return out;
  let auth: { cookie: string; crumb: string };
  try {
    auth = await getYahooAuth();
  } catch {
    return out;
  }
  const fetchChunk = (chunk: string[], a: { cookie: string; crumb: string }) =>
    fetch(`${YAHOO_QUOTE_URL(chunk.join(","))}&crumb=${encodeURIComponent(a.crumb)}`, {
      headers: { "User-Agent": BROWSER_UA, Cookie: a.cookie },
      signal: AbortSignal.timeout(10000),
    });
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += chunkSize) chunks.push(tickers.slice(i, i + chunkSize));
  for (const chunk of chunks) {
    try {
      let res = await fetchChunk(chunk, auth);
      if (res.status === 401 || res.status === 403) {
        yahooAuth = null;
        try { auth = await getYahooAuth(); res = await fetchChunk(chunk, auth); } catch { continue; }
      }
      if (!res.ok) continue;
      const data = await res.json();
      for (const q of data?.quoteResponse?.result ?? []) {
        if (q?.symbol) out.set(q.symbol, parseSpikeQuote(q));
      }
    } catch {
      // 청크 실패 — 해당 청크 티커는 이번 주기 스냅샷 없음
    }
  }
  return out;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd raddit-astro && npx vitest run`
Expected: PASS (4 tests)

- [ ] **Step 6: 커밋**

```bash
git add raddit-astro/package.json raddit-astro/package-lock.json \
  raddit-astro/src/lib/upstream.ts raddit-astro/src/lib/upstream.spike.test.ts
git commit -m "feat(api): 급등 탐지용 v7 quote 배치 조회 + vitest 도입

폴러가 감시 대상 ~120종목을 요청 2개로 스냅샷하기 위한 배치 함수.
기존 attachBidAskBatch의 crumb 인증·청크 패턴을 따르되, 감지에
필요한 필드(누적거래량·10일 평균 거래량·세션별 장외가)만 파싱한다.
파서는 순수 함수로 분리해 프로젝트 첫 유닛 테스트(vitest) 대상으로.

Refs #74"
```

---

### Task 2: 감지 판정 순수 함수 (judgeSpike · isMarketWindow)

**Files:**
- Create: `raddit-astro/src/lib/spike.ts`
- Test: `raddit-astro/src/lib/spike.test.ts`

**Interfaces:**
- Consumes: 없음 (이 태스크 분량은 순수 로직 — upstream 의존은 Task 3에서 추가).
- Produces (Task 3·5가 사용):
  ```ts
  export const SPIKE: { POLL_MS; WINDOW_MIN; MIN_HISTORY_MIN; PCT_REGULAR; PCT_EXT;
    VOL_RATIO; MIN_AVG_VOL; COOLDOWN_MS; SNAP_KEEP_MIN; ALERT_KEEP_MS; ALERT_MAX;
    NEWS_FRESH_SEC; WATCH_MAX };
  export interface SpikeSnapshot { t: number; price: number; cumVol: number | null; state: string; }
  export interface SpikeVerdict { price: number; change_pct: number; vol_ratio: number | null; market_state: string; }
  export function judgeSpike(snaps: SpikeSnapshot[], avgVol10d: number | null, nowSec: number): SpikeVerdict | null;
  export function isMarketWindow(now?: Date): boolean;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`raddit-astro/src/lib/spike.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { judgeSpike, isMarketWindow, SPIKE } from "./spike";
import type { SpikeSnapshot } from "./spike";

/** now 기준 minAgo분 전 스냅샷 생성 헬퍼 */
const NOW = 1_800_000_000; // 임의 epoch sec
const snap = (minAgo: number, price: number, cumVol: number | null, state = "REGULAR"): SpikeSnapshot =>
  ({ t: NOW - minAgo * 60, price, cumVol, state });

describe("judgeSpike — 정규장", () => {
  // 10일 평균 100만주 → 15분 기대 거래량 = 1_000_000/390*15 ≈ 38,462주
  const AVG = 1_000_000;

  it("가격 +3% 이상 AND 거래량 5배 이상 → 감지", () => {
    const v = judgeSpike([snap(15, 1.0, 500_000), snap(0, 1.04, 500_000 + 200_000)], AVG, NOW);
    expect(v).not.toBeNull();
    expect(v!.change_pct).toBeCloseTo(4, 5);
    expect(v!.vol_ratio).toBeGreaterThan(SPIKE.VOL_RATIO);
    expect(v!.market_state).toBe("REGULAR");
  });

  it("완만한 상승(+1%)은 거래량이 커도 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 0), snap(0, 1.01, 400_000)], AVG, NOW)).toBeNull();
  });

  it("거래량만 폭증(가격 보합)은 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 0), snap(0, 1.0, 400_000)], AVG, NOW)).toBeNull();
  });

  it("가격은 올랐지만 거래량 배율 미달이면 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 0), snap(0, 1.05, 10_000)], AVG, NOW)).toBeNull();
  });

  it("이력 10분 미만이면 미감지", () => {
    expect(judgeSpike([snap(5, 1.0, 0), snap(0, 1.1, 400_000)], AVG, NOW)).toBeNull();
  });

  it("누적거래량 감소(일자 리셋)면 vol_ratio 없음 → 미감지", () => {
    expect(judgeSpike([snap(15, 1.0, 900_000), snap(0, 1.05, 100)], AVG, NOW)).toBeNull();
  });
});

describe("judgeSpike — 장외·유동성", () => {
  it("프리마켓 +5% 이상은 거래량 없이 감지", () => {
    const v = judgeSpike([snap(15, 2.0, null, "PRE"), snap(0, 2.12, null, "PRE")], 1_000_000, NOW);
    expect(v).not.toBeNull();
    expect(v!.vol_ratio).toBeNull();
    expect(v!.market_state).toBe("PRE");
  });

  it("프리마켓 +4%는 미감지 (장외 임계 5%)", () => {
    expect(judgeSpike([snap(15, 2.0, null, "PRE"), snap(0, 2.08, null, "PRE")], 1_000_000, NOW)).toBeNull();
  });

  it("10일 평균 거래량 미달(초저유동성)은 무조건 미감지", () => {
    const v = judgeSpike(
      [snap(15, 1.0, 0, "REGULAR"), snap(0, 1.5, 400_000, "REGULAR")],
      SPIKE.MIN_AVG_VOL - 1, NOW);
    expect(v).toBeNull();
  });

  it("avg_vol_10d 미상(null)이면 미감지", () => {
    expect(judgeSpike([snap(15, 2.0, null, "PRE"), snap(0, 2.2, null, "PRE")], null, NOW)).toBeNull();
  });
});

describe("isMarketWindow", () => {
  // ET 기준 검증 — Date는 UTC로 만든다. 2026-07-15는 수요일, EDT(UTC-4).
  it("평일 정규장(ET 10:00)은 true", () => {
    expect(isMarketWindow(new Date("2026-07-15T14:00:00Z"))).toBe(true);
  });
  it("평일 프리마켓(ET 4:30)은 true", () => {
    expect(isMarketWindow(new Date("2026-07-15T08:30:00Z"))).toBe(true);
  });
  it("평일 새벽(ET 3:00)은 false", () => {
    expect(isMarketWindow(new Date("2026-07-15T07:00:00Z"))).toBe(false);
  });
  it("평일 애프터 종료 후(ET 20:30)은 false", () => {
    expect(isMarketWindow(new Date("2026-07-16T00:30:00Z"))).toBe(false);
  });
  it("토요일(ET)은 false", () => {
    expect(isMarketWindow(new Date("2026-07-18T14:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd raddit-astro && npx vitest run src/lib/spike.test.ts`
Expected: FAIL — `./spike` 모듈 없음.

- [ ] **Step 3: `src/lib/spike.ts` 생성 (이 태스크 분량은 순수 로직만)**

```ts
/**
 * 뉴스 선행 급등 탐지 (#74) — 감지 판정·링버퍼·알림 이력·폴링 루프.
 * 판정(judgeSpike)·장시간 판단(isMarketWindow)은 순수 함수로 유지해 테스트한다.
 */

// 감지 튜닝 상수 — 임계값 조정은 여기서만
export const SPIKE = {
  POLL_MS: 90_000,           // 폴링 간격
  WINDOW_MIN: 15,            // 급등 판정 구간(분)
  MIN_HISTORY_MIN: 10,       // 판정에 필요한 최소 이력(분)
  PCT_REGULAR: 3,            // 정규장 상승률 임계(%)
  PCT_EXT: 5,                // 장외 상승률 임계(%) — 거래량 검증 불가라 상향
  VOL_RATIO: 5,              // 거래량 배율 임계 (10일 평균의 분당 환산 대비)
  MIN_AVG_VOL: 50_000,       // 초저유동성 컷 (10일 평균 주식수)
  COOLDOWN_MS: 60 * 60_000,  // 같은 티커 재감지 금지 구간
  SNAP_KEEP_MIN: 45,         // 링버퍼 보존(분)
  ALERT_KEEP_MS: 48 * 3600_000, // 알림 이력 보존
  ALERT_MAX: 200,            // 알림 이력 최대 건수
  NEWS_FRESH_SEC: 12 * 3600, // "뉴스 있음" 판단 기준(최근 12시간)
  WATCH_MAX: 120,            // 감시 대상 티커 수
} as const;

export interface SpikeSnapshot {
  t: number;              // epoch sec
  price: number;          // 유효가 (장외 시간엔 장외가)
  cumVol: number | null;  // 당일 누적 거래량 (regularMarketVolume)
  state: string;          // PRE·REGULAR·POST·POSTPOST·CLOSED
}

export interface SpikeVerdict {
  price: number;
  change_pct: number;
  vol_ratio: number | null; // 장외 감지는 null
  market_state: string;
}

/**
 * 스냅샷 링버퍼로 급등 여부 판정.
 * 정규장: WINDOW_MIN분 상승률 ≥ PCT_REGULAR AND 거래량 배율 ≥ VOL_RATIO.
 * 장외: 상승률 ≥ PCT_EXT만 (Yahoo가 장외 거래량을 주지 않음).
 * avg_vol_10d 미상·저유동성이면 판정하지 않는다 (스프레드 왜곡 방지).
 */
export function judgeSpike(
  snaps: SpikeSnapshot[], avgVol10d: number | null, nowSec: number,
): SpikeVerdict | null {
  if (avgVol10d == null || avgVol10d < SPIKE.MIN_AVG_VOL) return null;
  const last = snaps[snaps.length - 1];
  if (!last) return null;
  // 판정 구간 시작점: WINDOW_MIN분 내에서 가장 오래된 스냅샷
  const from = nowSec - SPIKE.WINDOW_MIN * 60;
  const base = snaps.find(s => s.t >= from);
  if (!base || base === last || !base.price) return null;
  const elapsedSec = last.t - base.t;
  if (elapsedSec < SPIKE.MIN_HISTORY_MIN * 60) return null;

  const changePct = (last.price / base.price - 1) * 100;
  const regular = last.state === "REGULAR";
  let volRatio: number | null = null;
  if (regular && last.cumVol != null && base.cumVol != null) {
    const delta = last.cumVol - base.cumVol;
    if (delta >= 0) {
      // 10일 평균을 정규장 390분 기준 분당으로 환산해 같은 시간분량과 비교
      const expected = (avgVol10d / 390) * (elapsedSec / 60);
      if (expected > 0) volRatio = delta / expected;
    }
  }
  const hit = regular
    ? changePct >= SPIKE.PCT_REGULAR && volRatio != null && volRatio >= SPIKE.VOL_RATIO
    : changePct >= SPIKE.PCT_EXT;
  return hit
    ? { price: last.price, change_pct: changePct, vol_ratio: volRatio, market_state: last.state }
    : null;
}

/** 미 동부시간 기준 평일 4:00~20:00 (프리마켓 개장~애프터마켓 마감). DST는 타임존이 흡수. */
export function isMarketWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  return !["Sat", "Sun"].includes(get("weekday")) && hour >= 4 && hour < 20;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd raddit-astro && npx vitest run`
Expected: PASS (Task 1 포함 전체)

- [ ] **Step 5: 커밋**

```bash
git add raddit-astro/src/lib/spike.ts raddit-astro/src/lib/spike.test.ts
git commit -m "feat(spike): 급등 판정·장시간 판단 순수 함수

감지 핵심(15분 상승률+거래량 배율, 장외 별도 임계, 저유동성 컷)을
상태 없는 순수 함수로 격리해 합성 스냅샷으로 검증 가능하게 한다.
임계값은 SPIKE 상수 한곳에 모아 튜닝 지점을 단일화.

Refs #74"
```

---

### Task 3: 폴링 루프·알림 이력 (spike.ts 상태 관리부)

**Files:**
- Modify: `raddit-astro/src/lib/spike.ts` (Task 2 코드 아래에 추가)
- Test: `raddit-astro/src/lib/spike.test.ts` (이력 관리 테스트 추가)

**Interfaces:**
- Consumes: `up.fetchMentions("all-stocks")`, `up.fetchSpikeQuotes(tickers)` (Task 1), `up.fetchNews(ticker)` — 모두 `../lib/upstream`에 존재. Task 2의 `judgeSpike`·`isMarketWindow`·`SPIKE`.
- Produces (Task 4·5가 사용):
  ```ts
  export interface SpikeAlert {
    ticker: string; name: string | null;
    detected_at: number; price: number; change_pct: number;
    vol_ratio: number | null; market_state: string;
    news: "none" | "recent" | "unknown";
    news_title: string | null; news_url: string | null;
    last_price: number | null; since_pct: number | null;
  }
  export interface AlertsPayload { generated_at: string; market_open: boolean; alerts: SpikeAlert[]; }
  export function getAlerts(): AlertsPayload;
  export function ensureSpikeWatch(): void;   // 멱등 — 여러 번 불러도 폴러 1개
  export function recordAlert(a: SpikeAlert, nowMs?: number): void;  // 이력 push+트리밍 (테스트용 export)
  export function markAlerted(ticker: string, nowMs: number): void;  // 쿨다운 시작
  export function underCooldown(ticker: string, nowMs: number): boolean;
  export function _resetSpikeState(): void;   // 테스트 전용
  ```

- [ ] **Step 1: 이력 관리 실패하는 테스트 추가 (spike.test.ts 하단)**

```ts
import { recordAlert, getAlerts, markAlerted, underCooldown, _resetSpikeState } from "./spike";
import type { SpikeAlert } from "./spike";

const mkAlert = (ticker: string, detectedAtMs: number): SpikeAlert => ({
  ticker, name: null, detected_at: Math.floor(detectedAtMs / 1000),
  price: 1, change_pct: 5, vol_ratio: 6, market_state: "REGULAR",
  news: "none", news_title: null, news_url: null, last_price: 1, since_pct: 0,
});

describe("알림 이력 관리", () => {
  it("최신순으로 쌓이고 48시간 지난 건 제거", () => {
    _resetSpikeState();
    const now = Date.now();
    recordAlert(mkAlert("OLD", now - 49 * 3600_000), now);
    recordAlert(mkAlert("A", now - 3600_000), now);
    recordAlert(mkAlert("B", now), now);
    const { alerts } = getAlerts();
    expect(alerts.map(a => a.ticker)).toEqual(["B", "A"]);
  });

  it("최대 건수 초과 시 오래된 것부터 버림", () => {
    _resetSpikeState();
    const now = Date.now();
    // 실제 폴러처럼 시간순(오래된 것 먼저)으로 기록 — T204가 가장 오래됨
    for (let i = 204; i >= 0; i--) recordAlert(mkAlert(`T${i}`, now - i * 1000), now);
    expect(getAlerts().alerts.length).toBe(200);
    expect(getAlerts().alerts[0].ticker).toBe("T0"); // 가장 최근이 맨 앞
  });
});

describe("쿨다운", () => {
  it("markAlerted 후 60분 내 재감지 금지, 지나면 허용", () => {
    _resetSpikeState();
    const now = Date.now();
    expect(underCooldown("ABC", now)).toBe(false);
    markAlerted("ABC", now);
    expect(underCooldown("ABC", now + SPIKE.COOLDOWN_MS - 1)).toBe(true);
    expect(underCooldown("ABC", now + SPIKE.COOLDOWN_MS)).toBe(false);
    expect(underCooldown("XYZ", now)).toBe(false); // 다른 티커는 무관
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd raddit-astro && npx vitest run src/lib/spike.test.ts`
Expected: FAIL — `recordAlert` 미정의.

- [ ] **Step 3: spike.ts에 상태 관리부 구현 (파일 하단에 추가)**

파일 상단에 import 추가:
```ts
import * as up from "./upstream";
```

하단에 추가:
```ts
// ── 알림 이력·폴링 상태 (인메모리 — 재배포 시 소실 허용, 스펙 참조) ──

export interface SpikeAlert {
  ticker: string;
  name: string | null;
  detected_at: number;            // epoch sec
  price: number;                  // 감지 시점 가격
  change_pct: number;
  vol_ratio: number | null;
  market_state: string;
  news: "none" | "recent" | "unknown";
  news_title: string | null;
  news_url: string | null;
  last_price: number | null;      // 폴러가 매 주기 갱신
  since_pct: number | null;       // 감지가 대비 현재 등락
}

export interface AlertsPayload {
  generated_at: string;
  market_open: boolean;
  alerts: SpikeAlert[];
}

const snapsByTicker = new Map<string, SpikeSnapshot[]>();
const lastAlertAt = new Map<string, number>();   // 쿨다운용 (epoch ms)
let alerts: SpikeAlert[] = [];

/** 테스트 전용 — 모듈 상태 초기화. */
export function _resetSpikeState(): void {
  snapsByTicker.clear();
  lastAlertAt.clear();
  alerts = [];
}

/** 알림을 최신순 이력에 추가하고 보존 기준(48h·200건)으로 트리밍. */
export function recordAlert(a: SpikeAlert, nowMs: number = Date.now()): void {
  alerts.unshift(a);
  const cutoffSec = (nowMs - SPIKE.ALERT_KEEP_MS) / 1000;
  alerts = alerts.filter(x => x.detected_at >= cutoffSec).slice(0, SPIKE.ALERT_MAX);
}

export function getAlerts(): AlertsPayload {
  return {
    generated_at: new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }),
    market_open: isMarketWindow(),
    alerts,
  };
}

/** 쿨다운 시작 — 이 시각부터 COOLDOWN_MS 동안 같은 티커 재감지 금지. */
export function markAlerted(ticker: string, nowMs: number): void {
  lastAlertAt.set(ticker, nowMs);
}

/** 쿨다운 중인지 — 순수 조회 (폴러와 테스트가 공유). */
export function underCooldown(ticker: string, nowMs: number): boolean {
  const at = lastAlertAt.get(ticker);
  return at != null && nowMs - at < SPIKE.COOLDOWN_MS;
}

/** 감지 시점 뉴스 유무 — 실패는 unknown ("없음"으로 단정하지 않는다, 스펙 참조). */
async function checkNews(ticker: string): Promise<Pick<SpikeAlert, "news" | "news_title" | "news_url">> {
  try {
    const items = await up.fetchNews(ticker);
    const cutoff = Date.now() / 1000 - SPIKE.NEWS_FRESH_SEC;
    const fresh = items
      .filter(n => n.ts != null && n.ts >= cutoff)
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    return fresh.length
      ? { news: "recent", news_title: fresh[0].title ?? null, news_url: fresh[0].url ?? null }
      : { news: "none", news_title: null, news_url: null };
  } catch {
    return { news: "unknown", news_title: null, news_url: null };
  }
}

/** 1회 폴링: 감시 대상 스냅샷 축적 → 판정 → 알림 기록 → 기존 알림 시세 갱신. */
async function pollOnce(): Promise<void> {
  const mentions = await up.fetchMentions("all-stocks");
  const tickers = mentions.slice(0, SPIKE.WATCH_MAX).map(m => m.ticker);
  const quotes = await up.fetchSpikeQuotes(tickers);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  for (const [ticker, q] of quotes) {
    const price = q.ext_price ?? q.price;
    if (price == null || price <= 0) continue;

    const snaps = snapsByTicker.get(ticker) ?? [];
    snaps.push({ t: nowSec, price, cumVol: q.volume, state: q.market_state ?? "REGULAR" });
    while (snaps.length && snaps[0].t < nowSec - SPIKE.SNAP_KEEP_MIN * 60) snaps.shift();
    snapsByTicker.set(ticker, snaps);

    // 기존 알림의 "감지 후 등락" 갱신 — 같은 배치 응답이라 무비용
    for (const a of alerts) {
      if (a.ticker === ticker) {
        a.last_price = price;
        a.since_pct = (price / a.price - 1) * 100;
      }
    }

    if (underCooldown(ticker, nowMs)) continue;
    const verdict = judgeSpike(snaps, q.avg_vol_10d, nowSec);
    if (!verdict) continue;

    markAlerted(ticker, nowMs);
    const news = await checkNews(ticker);
    recordAlert({
      ticker, name: q.name, detected_at: nowSec, ...verdict, ...news,
      last_price: price, since_pct: 0,
    }, nowMs);
    console.log(`[spike] ${ticker} +${verdict.change_pct.toFixed(1)}% ` +
      `(${verdict.market_state}, vol×${verdict.vol_ratio?.toFixed(1) ?? "-"}, 뉴스 ${news.news})`);
  }
}

// ── 폴링 루프 기동 ──

let failStreak = 0;

/** 폴러 기동 — 멱등. 미들웨어가 요청마다 부르지만 globalThis 가드로 1회만. */
export function ensureSpikeWatch(): void {
  const g = globalThis as { __radditSpikeWatch?: boolean };
  if (g.__radditSpikeWatch) return;
  if (process.env.SPIKE_WATCH === "0") return;
  g.__radditSpikeWatch = true;
  console.log("[spike] 급등 감시 시작 (90초 간격, ET 4:00~20:00 평일)");

  const tick = async () => {
    let delay: number = SPIKE.POLL_MS;
    try {
      if (isMarketWindow()) await pollOnce();
      failStreak = 0;
    } catch (e) {
      failStreak++;
      console.error(`[spike] 폴링 실패 (${failStreak}연속):`, e instanceof Error ? e.message : e);
      if (failStreak >= 3) delay = 600_000; // 10분 백오프
    }
    setTimeout(tick, delay).unref?.();
  };
  setTimeout(tick, 5_000).unref?.(); // 기동 직후 요청 처리에 방해되지 않게 5초 뒤 시작
}
```

- [ ] **Step 4: 전체 테스트 통과 확인**

Run: `cd raddit-astro && npx vitest run`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add raddit-astro/src/lib/spike.ts raddit-astro/src/lib/spike.test.ts
git commit -m "feat(spike): 폴링 루프·알림 이력 관리

장 시간대에만 90초 간격으로 감시 대상을 배치 스냅샷하고, 판정
통과 시 뉴스 유무(12h)를 붙여 인메모리 이력(48h·200건)에 기록.
사이클 전체를 try/catch로 감싸고 연속 3회 실패 시 10분 백오프 —
폴러 장애가 서버에 전파되지 않게 한다. 뉴스 조회 실패는 '없음'과
구분되는 unknown으로 기록.

Refs #74"
```

---

### Task 4: 폴러 기동 미들웨어 + /api/alerts 라우트

**Files:**
- Create: `raddit-astro/src/middleware.ts`
- Create: `raddit-astro/src/pages/api/alerts.ts`

**Interfaces:**
- Consumes: `ensureSpikeWatch()`, `getAlerts()` (Task 3).
- Produces: `GET /api/alerts` → `AlertsPayload` JSON (Task 5가 fetch).

- [ ] **Step 1: `src/middleware.ts` 생성**

```ts
/**
 * Astro node standalone에는 서버 부팅 훅이 없어, 첫 요청에서 급등
 * 감시 폴러를 기동한다 (#74). ensureSpikeWatch는 멱등 — 요청마다
 * 불러도 폴러는 1개.
 */
import { defineMiddleware } from "astro:middleware";
import { ensureSpikeWatch } from "@/lib/spike";

export const onRequest = defineMiddleware((_ctx, next) => {
  ensureSpikeWatch();
  return next();
});
```

- [ ] **Step 2: `src/pages/api/alerts.ts` 생성**

```ts
import type { APIRoute } from "astro";
import { getAlerts } from "@/lib/spike";

// 인메모리 이력 직렬화 — 항상 최신을 줘야 하므로 캐시하지 않는다
export const GET: APIRoute = async () =>
  Response.json(getAlerts(), { headers: { "Cache-Control": "no-store" } });
```

- [ ] **Step 3: 타입 체크**

Run: `cd raddit-astro && npx astro check`
Expected: 에러 0 (기존 경고 수준 유지)

- [ ] **Step 4: dev 서버 스모크 테스트**

Git Bash에서:
```bash
cd raddit-astro && (npm run dev &) && sleep 8 && curl -s http://localhost:4321/api/alerts
```
Expected: `{"generated_at":"…","market_open":…,"alerts":[]}` + 서버 로그에 `[spike] 급등 감시 시작` 1회.
확인 후 dev 서버 종료 (`kill %1` 또는 프로세스 종료).

- [ ] **Step 5: 커밋**

```bash
git add raddit-astro/src/middleware.ts raddit-astro/src/pages/api/alerts.ts
git commit -m "feat(api): /api/alerts 라우트 + 폴러 기동 미들웨어

Astro node standalone은 부팅 훅이 없어 미들웨어에서 lazy-start.
알림 이력은 인메모리 직렬화라 no-store로 항상 최신을 반환한다.

Refs #74"
```

---

### Task 5: Dashboard "⚡ 급등" 뷰

**Files:**
- Modify: `raddit-astro/src/components/Dashboard.tsx`
- Modify: `raddit-astro/src/layouts/Layout.astro` (배지 CSS)

**Interfaces:**
- Consumes: `GET /api/alerts` (Task 4), 기존 `openDetail(ticker)`·`viewMode`/`switchView`·테이블 CSS(`.board .scroller table`, `.pill`).
- Produces: viewMode 유니언에 `"alerts"` 추가 — 사용자 노출 UI.

- [ ] **Step 1: viewMode 유니언 확장 (Dashboard.tsx 90행 부근)**

기존:
```ts
const [viewMode, setViewMode] = createSignal<"list" | "grid">("list");
const switchView = (m: "list" | "grid") => { setViewMode(m); try { localStorage.setItem("raddit-view", m); } catch {} };
```
변경:
```ts
type ViewMode = "list" | "grid" | "alerts";
const [viewMode, setViewMode] = createSignal<ViewMode>("list");
const switchView = (m: ViewMode) => { setViewMode(m); try { localStorage.setItem("raddit-view", m); } catch {} };
```

- [ ] **Step 2: 알림 상태·로더 추가 (다른 createSignal 선언들 옆)**

```ts
// ⚡ 급등 감지 뷰 (#74)
interface AlertRow {
  ticker: string; name: string | null; detected_at: number;
  price: number; change_pct: number; vol_ratio: number | null;
  market_state: string; news: "none" | "recent" | "unknown";
  news_title: string | null; news_url: string | null;
  last_price: number | null; since_pct: number | null;
}
const [alertRows, setAlertRows] = createSignal<AlertRow[]>([]);
const [alertsOpen, setAlertsOpen] = createSignal<boolean | null>(null); // market_open
const [alertsErr, setAlertsErr] = createSignal("");

const loadAlerts = async () => {
  try {
    const res = await fetch("/api/alerts");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    setAlertRows(d.alerts ?? []);
    setAlertsOpen(d.market_open ?? null);
    setAlertsErr("");
  } catch {
    setAlertsErr("급등 이력을 불러오지 못했습니다");
  }
};
```

- [ ] **Step 3: 뷰 활성 시 60초 갱신 (onMount 근처에 추가)**

파일 상단 import에 `createEffect` 추가 (`solid-js`에서), 컴포넌트 본문에:
```ts
// 알림 뷰가 열려 있는 동안만 60초 갱신 — 상세 모달 분 탭의 60초 관례와 동일
createEffect(() => {
  if (viewMode() !== "alerts") return;
  loadAlerts();
  const id = setInterval(loadAlerts, 60_000);
  onCleanup(() => clearInterval(id));
});
```

- [ ] **Step 4: localStorage 복원 확장 (onMount 안, 기존 730행 부근)**

기존:
```ts
try { if (localStorage.getItem("raddit-view") === "grid") setViewMode("grid"); } catch {}
```
변경:
```ts
try {
  const saved = localStorage.getItem("raddit-view");
  if (saved === "grid" || saved === "alerts") setViewMode(saved);
} catch {}
```

- [ ] **Step 5: 뷰 토글 버튼 추가 (798행 부근 view-toggle div)**

```tsx
<div class="view-toggle" role="group" aria-label="보기 모드">
  <button type="button" class={viewMode() === "list" ? "active" : ""} onClick={() => switchView("list")}>목록</button>
  <button type="button" class={viewMode() === "grid" ? "active" : ""} onClick={() => switchView("grid")}>스크리너</button>
  <button type="button" class={viewMode() === "alerts" ? "active" : ""} onClick={() => switchView("alerts")}>⚡ 급등</button>
</div>
```

- [ ] **Step 6: 알림 테이블 렌더 (board 안, `<Show when={viewMode() === "grid"}>` 블록 뒤에)**

board-head의 hint도 분기 추가:
```tsx
<span class="hint">{viewMode() === "list" ? "열 제목 클릭 → 정렬 · 행 클릭 → 실시간 차트와 분석"
  : viewMode() === "grid" ? "카드 클릭 → 실시간 차트와 분석"
  : "이상 급등 감지 이력 · 행 클릭 → 실시간 차트와 분석"}</span>
```

알림 테이블:
```tsx
<Show when={viewMode() === "alerts"}>
  <div class="scroller">
    <table>
      <thead><tr>
        <th>감지 시각</th><th class="left">종목</th><th>세션</th><th>상승률</th>
        <th>거래량</th><th class="left">뉴스</th><th>감지가</th><th>이후 등락</th>
      </tr></thead>
      <tbody>
        <Show when={alertRows().length} fallback={
          <tr><td class="empty" colspan="8">
            {alertsErr() || (alertsOpen() === false
              ? "미국 장 외 시간입니다 (감시: 평일 ET 4:00~20:00)"
              : "아직 감지된 급등이 없습니다")}
          </td></tr>
        }>
          <For each={alertRows()}>{(a) => (
            <tr tabindex="0"
              onClick={() => openDetail(a.ticker)}
              onKeyDown={(e) => { if (e.key === "Enter") openDetail(a.ticker); }}
            >
              <td class="dim">{new Date(a.detected_at * 1000).toLocaleTimeString("ko-KR",
                { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })}</td>
              <td class="left"><span class="tk">{a.ticker}</span><br /><span class="name">{a.name || ""}</span></td>
              <td><span class="pill flat">{a.market_state === "PRE" ? "프리" : a.market_state === "REGULAR" ? "정규" : "애프터"}</span></td>
              <td><span class="pill up">+{a.change_pct.toFixed(1)}%</span></td>
              <td class="dim">{a.vol_ratio != null ? `×${a.vol_ratio.toFixed(1)}` : "-"}</td>
              <td class="left">
                {a.news === "none"
                  ? <span class="news-badge lead">뉴스 없음 · 선행 가능성</span>
                  : a.news === "recent"
                    ? <a class="news-badge has" href={a.news_url ?? "#"} target="_blank"
                        rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                        title={a.news_title ?? ""}>뉴스 있음</a>
                    : <span class="news-badge">확인 실패</span>}
              </td>
              <td>${a.price.toFixed(2)}</td>
              <td>{a.since_pct != null
                ? <span class={`pill ${a.since_pct > 0 ? "up" : a.since_pct < 0 ? "down" : "flat"}`}>
                    {(a.since_pct > 0 ? "+" : "") + a.since_pct.toFixed(1)}%</span>
                : "-"}</td>
            </tr>
          )}</For>
        </Show>
      </tbody>
    </table>
  </div>
</Show>
```

- [ ] **Step 7: 배지 CSS 추가 (Layout.astro의 `.view-toggle` 규칙 근처)**

```css
.news-badge { display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: .78rem; color: var(--ink-2); border: 1px solid var(--line); }
.news-badge.lead { color: var(--up); background: var(--up-soft); border-color: transparent; font-weight: 600; }
.news-badge.has { color: var(--accent); background: var(--accent-soft); border-color: transparent; text-decoration: none; }
```

- [ ] **Step 8: 타입 체크 + 수동 확인**

Run: `cd raddit-astro && npx astro check`
Expected: 에러 0.

dev 서버(`npm run dev`)를 띄우고 브라우저에서:
- "⚡ 급등" 버튼 → 빈 상태 문구(장외면 "미국 장 외 시간…") 표시
- 뷰 전환·새로고침 후에도 alerts 뷰 유지 (localStorage)
- 목록/스크리너 뷰 정상 동작 (회귀 없음)

- [ ] **Step 9: 커밋**

```bash
git add raddit-astro/src/components/Dashboard.tsx raddit-astro/src/layouts/Layout.astro
git commit -m "feat(ui): 급등 감지 이력 뷰 추가 (⚡ 급등)

감지 시각·상승률·거래량 배율·뉴스 유무·감지 후 등락을 시간순으로
보여줘 '뉴스 전에 움직인 종목'을 회고할 수 있게 한다. 목록·스크리너와
같은 뷰 토글 자리에 두고, 뷰가 열려 있는 동안만 60초 갱신.

Refs #74"
```

---

### Task 6: 통합 검증

**Files:** (수정 없음 — 검증만. 문제 발견 시 해당 태스크 파일 수정)

- [ ] **Step 1: 전체 테스트**

Run: `cd raddit-astro && npx vitest run`
Expected: 전부 PASS

- [ ] **Step 2: 프로덕션 빌드**

Run: `cd raddit-astro && npm run build`
Expected: 빌드 성공 (경고만 허용)

- [ ] **Step 3: 프로덕션 모드 스모크**

```bash
cd raddit-astro && (node ./dist/server/entry.mjs &) && sleep 5 \
  && curl -s http://localhost:4321/api/alerts && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321/
```
Expected: alerts JSON + 메인 페이지 200, 서버 로그에 `[spike] 급등 감시 시작` 1회만. 확인 후 프로세스 종료.

- [ ] **Step 4: (장중이라면) 실감지 확인**

미국 장 시간대(한국 밤~새벽, 프리마켓은 KST 17:00~)라면 몇 분 두고 `/api/alerts`를 다시 조회해 스냅샷 축적·감지 동작 확인. 장외라면 이 단계는 dev 배포 후로 미룬다 (이슈 체크리스트 항목).

- [ ] **Step 5: 수정이 있었다면 커밋, 없으면 종료**

수정 발생 시:
```bash
git add -A && git commit -m "fix(spike): 통합 검증 중 발견된 문제 수정

<무엇이 왜 문제였는지>

Refs #74"
```
