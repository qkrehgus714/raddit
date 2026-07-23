# 종목별 공매도 현황 표시 (#76) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상세 모달에 공매도 잔고(Yahoo, 격주)·일별 공매도 거래 비중(FINRA, 전일)을, ⚡ 급등 뷰에 숏 비중 컬럼을 표시한다.

**Architecture:** 독립 엔드포인트 `/api/short` 신설(A안 — detail/fundamentals에 합치지 않음). 업스트림 파싱은 순수 함수로 분리해 vitest로 검증. FINRA 전 종목 맵은 services 모듈 레벨 캐시(24h)로 `getShortData`와 `/api/alerts`가 공유하고, alerts 라우트는 lookup만 한다(미로드 시 null).

**Tech Stack:** Astro 7 + SolidJS, vitest 4, 인메모리 TtlCache. 스펙: `docs/superpowers/specs/2026-07-18-short-interest-design.md`, 이슈 #76.

## Global Constraints

- **main/dev 직접 push 금지** — 커밋은 `feat/short-interest` 브랜치에만. push·PR은 사용자 지시가 있을 때만.
- 커밋: Conventional Commits + 한국어 (`<type>(<scope>): 요약`), body에 "왜"를 쓴다. 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **node/npm은 PowerShell에서 안 잡힘 — 모든 npm/npx 명령은 Bash 툴로**, 작업 디렉터리 `/c/parkdohyun/raddit/raddit-astro`.
- 테스트: `npx vitest run <파일>` (전체는 `npm test`). 타입 체크: `npx astro check`.
- Yahoo 인증 실패(401/403)는 crumb 재발급 후 1회 재시도 — `fetchBidAsk` 기존 패턴 준수.
- 모든 지표 필드는 결손 허용(null), UI 표기는 `-`.

---

### Task 1: Yahoo 공매도 잔고 업스트림 — `parseShortInterest` + `fetchShortInterest`

**Files:**
- Modify: `raddit-astro/src/lib/upstream.ts` (fetchSpikeQuotes 블록 뒤, `// ── 급등 탐지용 배치 시세` 섹션과 `ChartData` 사이에 새 섹션 추가)
- Test: `raddit-astro/src/lib/upstream.short.test.ts` (신규)

**Interfaces:**
- Consumes: 기존 `getYahooAuth()`, `yahooAuth`(모듈 변수), `BROWSER_UA`, `round4()` — 모두 upstream.ts 내부.
- Produces: `export interface ShortInterest { shares_short: number|null; shares_short_prior: number|null; short_ratio: number|null; short_pct_float: number|null; date_short_interest: number|null }`, `export function parseShortInterest(raw: any): ShortInterest`, `export async function fetchShortInterest(ticker: string, retry?: boolean): Promise<ShortInterest>` (HTTP 실패 시 **throw** — fetchBidAsk와 달리 null 반환 아님. getShortData의 allSettled가 error 필드로 격리하기 위함).

- [ ] **Step 1: 실패하는 테스트 작성** — `upstream.short.test.ts` 신규 생성:

```ts
import { describe, expect, it } from "vitest";
import { parseShortInterest } from "./upstream";

// Yahoo v10 quoteSummary 응답 축약 헬퍼
const yahooRes = (ks: any) => ({ quoteSummary: { result: [{ defaultKeyStatistics: ks }] } });

describe("parseShortInterest", () => {
  it("정상 응답 — 모든 필드 추출, shortPercentOfFloat 는 % 환산", () => {
    const si = parseShortInterest(yahooRes({
      sharesShort: { raw: 1_000_000 },
      sharesShortPriorMonth: { raw: 800_000 },
      shortRatio: { raw: 3.21 },
      shortPercentOfFloat: { raw: 0.1034 },
      dateShortInterest: { raw: 1_751_241_600 },
    }));
    expect(si).toEqual({
      shares_short: 1_000_000,
      shares_short_prior: 800_000,
      short_ratio: 3.21,
      short_pct_float: 10.34,
      date_short_interest: 1_751_241_600,
    });
  });

  it("결손 필드는 null (페니주식 — shortPercentOfFloat 없음)", () => {
    const si = parseShortInterest(yahooRes({ sharesShort: { raw: 5000 } }));
    expect(si.shares_short).toBe(5000);
    expect(si.short_pct_float).toBeNull();
    expect(si.short_ratio).toBeNull();
    expect(si.shares_short_prior).toBeNull();
    expect(si.date_short_interest).toBeNull();
  });

  it("빈 응답·result 없음 — 전 필드 null", () => {
    for (const raw of [null, {}, { quoteSummary: { result: [] } }]) {
      const si = parseShortInterest(raw);
      expect(si).toEqual({
        shares_short: null, shares_short_prior: null, short_ratio: null,
        short_pct_float: null, date_short_interest: null,
      });
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx vitest run src/lib/upstream.short.test.ts`
Expected: FAIL — `parseShortInterest` export 없음 (SyntaxError/undefined).

- [ ] **Step 3: 구현** — upstream.ts, `fetchSpikeQuotes` 함수 끝(299행 부근)과 `export interface ChartData` 사이에 추가:

```ts
// ── 공매도 잔고 (#76) — Yahoo v10 quoteSummary, FINRA 격주 보고 기반(~2주 지연) ──

const YAHOO_QUOTESUMMARY_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics`;

export interface ShortInterest {
  shares_short: number | null;        // sharesShort.raw
  shares_short_prior: number | null;  // sharesShortPriorMonth.raw (전월)
  short_ratio: number | null;         // shortRatio.raw (days to cover)
  short_pct_float: number | null;     // shortPercentOfFloat.raw × 100 (%)
  date_short_interest: number | null; // dateShortInterest.raw (epoch sec, 보고 기준일)
}

/** v10 quoteSummary 응답 → 공매도 필드만. 모든 필드 결손 허용(null). */
export function parseShortInterest(raw: any): ShortInterest {
  const ks = raw?.quoteSummary?.result?.[0]?.defaultKeyStatistics ?? {};
  const pct = ks.shortPercentOfFloat?.raw;
  return {
    shares_short: ks.sharesShort?.raw ?? null,
    shares_short_prior: ks.sharesShortPriorMonth?.raw ?? null,
    short_ratio: ks.shortRatio?.raw ?? null,
    short_pct_float: pct != null ? round4(pct * 100) : null,
    date_short_interest: ks.dateShortInterest?.raw ?? null,
  };
}

/**
 * 공매도 잔고 조회 (crumb 인증 — fetchBidAsk 패턴). 401/403 시 재발급 후 1회 재시도.
 * fetchBidAsk와 달리 실패 시 throw — getShortData 의 allSettled 가 error 로 격리한다.
 */
export async function fetchShortInterest(ticker: string, retry = true): Promise<ShortInterest> {
  const { cookie, crumb } = await getYahooAuth();
  const url = `${YAHOO_QUOTESUMMARY_URL(ticker)}&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    if (retry && (res.status === 401 || res.status === 403)) {
      yahooAuth = null;
      return fetchShortInterest(ticker, false);
    }
    throw new Error(`Yahoo quoteSummary 응답 ${res.status}`);
  }
  return parseShortInterest(await res.json());
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx vitest run src/lib/upstream.short.test.ts`
Expected: PASS 3건.

- [ ] **Step 5: 커밋**

```bash
git add raddit-astro/src/lib/upstream.ts raddit-astro/src/lib/upstream.short.test.ts
git commit -m "feat(api): Yahoo 공매도 잔고 업스트림 fetchShortInterest 추가"
```
(body: 이슈 #76 v1 — 기존 crumb 인증 재사용, 파싱은 순수 함수로 분리해 테스트.)

---

### Task 2: FINRA 일별 공매도 파일 업스트림 — `finraDateCandidates` + `parseFinraShortVolume` + `fetchFinraShortVolume`

**Files:**
- Modify: `raddit-astro/src/lib/upstream.ts` (Task 1 섹션 바로 뒤에 이어서)
- Test: `raddit-astro/src/lib/upstream.short.test.ts` (추가)

**Interfaces:**
- Consumes: `BROWSER_UA`, `round4()`.
- Produces:
  - `export function finraDateCandidates(now?: Date, max?: number): string[]` — ET 기준 전일부터 주말 건너뛰며 최대 5개 `YYYYMMDD`.
  - `export function parseFinraShortVolume(text: string): Map<string, { short_vol_pct: number; total_volume: number }>`
  - `export interface FinraShortVolume { date: string; map: Map<string, { short_vol_pct: number; total_volume: number }> }`
  - `export async function fetchFinraShortVolume(now?: Date): Promise<FinraShortVolume | null>` — 5영업일 내 파일 없으면(연휴) null, 404 외 HTTP 오류·네트워크 오류는 throw.

- [ ] **Step 1: 실패하는 테스트 추가** — `upstream.short.test.ts` 에 append (import 줄도 갱신):

```ts
import { finraDateCandidates, parseFinraShortVolume } from "./upstream";

// 2026-07: 1일(수), 13일(월), 15일(수), 18일(토)
describe("finraDateCandidates", () => {
  it("평일(수) — 전일부터 5영업일, 주말 건너뜀", () => {
    expect(finraDateCandidates(new Date("2026-07-15T14:00:00Z"))).toEqual(
      ["20260714", "20260713", "20260710", "20260709", "20260708"]);
  });

  it("월요일 — 금요일 파일로 거슬러 올라감", () => {
    expect(finraDateCandidates(new Date("2026-07-13T14:00:00Z"))).toEqual(
      ["20260710", "20260709", "20260708", "20260707", "20260706"]);
  });

  it("일요일 — 직전 금요일부터", () => {
    expect(finraDateCandidates(new Date("2026-07-12T14:00:00Z"))).toEqual(
      ["20260710", "20260709", "20260708", "20260707", "20260706"]);
  });

  it("UTC 새벽은 ET 전날로 계산 (수 02:00Z = ET 화 22:00 → 월요일부터)", () => {
    expect(finraDateCandidates(new Date("2026-07-15T02:00:00Z"))[0]).toBe("20260713");
  });
});

describe("parseFinraShortVolume", () => {
  const HEADER = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market";

  it("정상 파일 — 비중 계산·라운딩", () => {
    const map = parseFinraShortVolume(
      `${HEADER}\n20260717|ABCD|373|0|1000|B,Q,N\n20260717|EFGH|1|0|3|Q\n`);
    expect(map.get("ABCD")).toEqual({ short_vol_pct: 37.3, total_volume: 1000 });
    expect(map.get("EFGH")!.short_vol_pct).toBeCloseTo(33.3333, 3);
  });

  it("헤더만 있으면 빈 맵", () => {
    expect(parseFinraShortVolume(`${HEADER}\n`).size).toBe(0);
  });

  it("TotalVolume 0·숫자 아님 행은 제외", () => {
    const map = parseFinraShortVolume(
      `${HEADER}\n20260717|ZERO|10|0|0|Q\n20260717|BAD|x|0|y|Q\n20260717|OK|5|0|10|Q\n`);
    expect(map.size).toBe(1);
    expect(map.get("OK")!.short_vol_pct).toBe(50);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx vitest run src/lib/upstream.short.test.ts`
Expected: FAIL — `finraDateCandidates` export 없음.

- [ ] **Step 3: 구현** — upstream.ts, Task 1 블록 바로 뒤에 추가:

```ts
// ── FINRA Reg SHO 일별 공매도 거래 비중 (#76 v2) — 무인증, 전 종목 단일 파일 ──

const FINRA_SHVOL_URL = (yyyymmdd: string) =>
  `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`;

/**
 * 시도할 파일 날짜 후보 — ET 기준 전일부터 주말을 건너뛰며 최대 max개 (YYYYMMDD).
 * 파일은 장 마감 후 저녁 게시라 당일분은 없다고 가정. 휴일 404는 호출부가 다음 후보로.
 */
export function finraDateCandidates(now: Date = new Date(), max = 5): string[] {
  const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const d = new Date(`${etToday}T00:00:00Z`);
  const out: string[] = [];
  while (out.length < max) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return out;
}

/**
 * 파이프 구분 파일 파싱: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market.
 * 헤더·형식 불일치·TotalVolume 0 행은 제외. short_vol_pct = Short/Total × 100.
 */
export function parseFinraShortVolume(
  text: string,
): Map<string, { short_vol_pct: number; total_volume: number }> {
  const map = new Map<string, { short_vol_pct: number; total_volume: number }>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const symbol = parts[1];
    const sv = Number(parts[2]);
    const tv = Number(parts[4]);
    if (!symbol || symbol === "Symbol" || !Number.isFinite(sv) || !Number.isFinite(tv) || tv <= 0) continue;
    map.set(symbol, { short_vol_pct: round4((sv / tv) * 100), total_volume: tv });
  }
  return map;
}

export interface FinraShortVolume {
  date: string; // YYYYMMDD — 실제로 로드된 파일 날짜
  map: Map<string, { short_vol_pct: number; total_volume: number }>;
}

/**
 * 가장 최근 영업일 파일을 내려받아 파싱. 404(주말·휴일)는 다음 후보로 넘어가고
 * 5영업일 내 파일이 없으면 null. 그 외 HTTP 오류·네트워크 오류는 throw.
 */
export async function fetchFinraShortVolume(now: Date = new Date()): Promise<FinraShortVolume | null> {
  for (const date of finraDateCandidates(now)) {
    const res = await fetch(FINRA_SHVOL_URL(date), {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`FINRA Reg SHO 응답 ${res.status}`);
    const map = parseFinraShortVolume(await res.text());
    if (map.size) return { date, map };
  }
  return null;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx vitest run src/lib/upstream.short.test.ts`
Expected: PASS 10건 (Task 1의 3건 포함).

- [ ] **Step 5: 실호출 스모크 (선택·네트워크)** — FINRA CDN 무인증이므로 안전:

Run(Bash): `curl -s -o /dev/null -w "%{http_code}" "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260716.txt"`
Expected: `200` (휴일이었다면 404 — 다른 최근 영업일로 재시도).

- [ ] **Step 6: 커밋**

```bash
git add raddit-astro/src/lib/upstream.ts raddit-astro/src/lib/upstream.short.test.ts
git commit -m "feat(api): FINRA 일별 공매도 거래 비중 업스트림 추가"
```
(body: 이슈 #76 v2 — 날짜 후보·파싱을 순수 함수로 분리, 주말·휴일 404는 최대 5영업일 소급.)

---

### Task 3: 서비스 `getShortData` + FINRA 공유 캐시 + `/api/short` 라우트

**Files:**
- Modify: `raddit-astro/src/lib/services.ts` (파일 끝 `getSearch` 뒤에 추가)
- Create: `raddit-astro/src/pages/api/short.ts`

**Interfaces:**
- Consumes: Task 1 `up.fetchShortInterest(ticker): Promise<up.ShortInterest>` (실패 시 throw), Task 2 `up.fetchFinraShortVolume(): Promise<up.FinraShortVolume | null>`, 기존 `TtlCache`, `kstTime()`, `reason()`.
- Produces:
  - `export interface ShortPayload { ticker: string; interest: up.ShortInterest | null; daily: { date: string; short_vol_pct: number } | null; error: string | null; generated_at: string }`
  - `export async function getShortData(ticker: string): Promise<ShortPayload>`
  - `export async function getFinraShortMap(): Promise<up.FinraShortVolume | null>` — 24h 캐시(실패 시 60s 후 재시도), 요청 합치기.
  - `export function peekFinraShortMap(): up.FinraShortVolume | null` — 로드 안 하고 캐시만 조회 (Task 4의 alerts 라우트용).
  - GET `/api/short?ticker=X` → `ShortPayload` JSON.

- [ ] **Step 1: services.ts 구현** — 파일 끝에 추가:

```ts
// ── 공매도 현황 (#76) ──

const shortCache = new TtlCache<ShortPayload>(12 * 3600_000, 3600_000);

// FINRA 전 종목 맵 — getShortData 와 /api/alerts 라우트가 공유하는 모듈 레벨 캐시.
// 하루 1회 갱신이면 충분(전일 파일). 실패는 null 캐시 후 60초 뒤 재시도.
let finraCache: { at: number; data: up.FinraShortVolume | null } | null = null;
let finraInflight: Promise<up.FinraShortVolume | null> | null = null;
const FINRA_TTL_OK_MS = 24 * 3600_000;
const FINRA_TTL_ERR_MS = 60_000;

export async function getFinraShortMap(): Promise<up.FinraShortVolume | null> {
  const ttl = finraCache?.data ? FINRA_TTL_OK_MS : FINRA_TTL_ERR_MS;
  if (finraCache && Date.now() - finraCache.at < ttl) return finraCache.data;
  if (!finraInflight) {
    finraInflight = up.fetchFinraShortVolume()
      .catch(() => null) // 장애도 null — 호출부는 결손 처리, 60초 뒤 재시도
      .then(data => { finraCache = { at: Date.now(), data }; return data; })
      .finally(() => { finraInflight = null; });
  }
  return finraInflight;
}

/** 캐시된 FINRA 맵 동기 조회 — 로드를 트리거하지 않는다 (/api/alerts 무비용 lookup용). */
export function peekFinraShortMap(): up.FinraShortVolume | null {
  return finraCache?.data ?? null;
}

export interface ShortPayload {
  ticker: string;
  interest: up.ShortInterest | null;                      // v1 — Yahoo, 격주
  daily: { date: string; short_vol_pct: number } | null;  // v2 — FINRA, 전일
  error: string | null;                                   // 두 소스 모두 실패 시에만
  generated_at: string;
}

/** 공매도 잔고 + 일별 비중 — 한쪽 실패해도 나머지는 표시 (getFundamentals 식 격리). */
export async function getShortData(ticker: string): Promise<ShortPayload> {
  return shortCache.getOrCompute(ticker, async () => {
    const [si, finra] = await Promise.allSettled([up.fetchShortInterest(ticker), getFinraShortMap()]);
    const interest = si.status === "fulfilled" ? si.value : null;
    const finraData = finra.status === "fulfilled" ? finra.value : null;
    const row = finraData?.map.get(ticker.toUpperCase());
    const daily = finraData && row ? { date: finraData.date, short_vol_pct: row.short_vol_pct } : null;
    const bothFailed = si.status === "rejected" && finraData == null;
    return {
      ticker,
      interest,
      daily,
      error: bothFailed ? (si.status === "rejected" ? reason(si) : "공매도 데이터 없음") : null,
      generated_at: kstTime(),
    };
  }, {
    // 격주 데이터라 성공은 길게(12h), 실패는 짧게 캐시해 곧 재시도
    ttlFor: v => (v.error ? 60_000 : 12 * 3600_000),
  });
}
```

- [ ] **Step 2: `/api/short` 라우트 생성** — `raddit-astro/src/pages/api/short.ts` (fundamentals.ts와 동일 구조):

```ts
import type { APIRoute } from "astro";
import { getShortData } from "@/lib/services";
import { TICKER_RE, errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase();
  if (!TICKER_RE.test(ticker)) return jsonError("잘못된 티커입니다.", 400);
  try {
    const payload = await getShortData(ticker);
    const ttl = payload.error ? 60 : 600;
    return jsonCached(payload, ttl, ttl);
  } catch (exc) {
    return jsonError(`공매도 데이터 수집 실패: ${errMsg(exc)}`, 502);
  }
};
```

- [ ] **Step 3: 타입 체크 + 전체 테스트**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx astro check && npm test`
Expected: astro check 0 errors, vitest 전부 PASS.

- [ ] **Step 4: 실동작 스모크** — dev 서버로 응답 확인:

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && (npm run dev -- --port 3300 &) && sleep 4 && curl -s "http://localhost:3300/api/short?ticker=TSLA"`
Expected: `{"ticker":"TSLA","interest":{...shares_short 등...},"daily":{"date":"202607..","short_vol_pct":..},...}` — 이후 서버 종료(`kill`).
(주의: Yahoo 레이트리밋 등으로 interest가 null이어도 daily가 채워지면 격리 동작 정상.)

- [ ] **Step 5: 커밋**

```bash
git add raddit-astro/src/lib/services.ts raddit-astro/src/pages/api/short.ts
git commit -m "feat(api): /api/short 라우트 + getShortData 서비스 추가"
```
(body: 격주 데이터 특성에 맞춘 12h 캐시. detail/fundamentals에 안 합친 이유(A안)는 스펙 참조.)

---

### Task 4: `/api/alerts` 응답에 `short_vol_pct` 병합

**Files:**
- Modify: `raddit-astro/src/pages/api/alerts.ts`

**Interfaces:**
- Consumes: Task 3 `peekFinraShortMap()`, 기존 `getAlerts(): AlertsPayload`.
- Produces: alerts 각 항목에 `short_vol_pct: number | null` 추가된 JSON. `spike.ts`의 `SpikeAlert` 타입·폴러는 **변경하지 않는다**.

- [ ] **Step 1: 라우트 수정** — alerts.ts 전체를 다음으로 교체:

```ts
import type { APIRoute } from "astro";
import { getAlerts } from "@/lib/spike";
import { peekFinraShortMap } from "@/lib/services";

// 인메모리 이력 직렬화 — 항상 최신을 줘야 하므로 캐시하지 않는다.
// 숏 비중(#76)은 FINRA 공유 캐시 lookup만 — 미로드·해당 티커 없음이면 null.
export const GET: APIRoute = async () => {
  const payload = getAlerts();
  const finra = peekFinraShortMap();
  const alerts = payload.alerts.map(a => ({
    ...a,
    short_vol_pct: finra?.map.get(a.ticker)?.short_vol_pct ?? null,
  }));
  return Response.json({ ...payload, alerts }, { headers: { "Cache-Control": "no-store" } });
};
```

- [ ] **Step 2: 타입 체크**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx astro check`
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add raddit-astro/src/pages/api/alerts.ts
git commit -m "feat(api): /api/alerts 응답에 숏 비중 병합"
```
(body: FINRA 공유 캐시 lookup만 수행 — 폴러·SpikeAlert 타입은 불변. 맵 미로드 시 null.)

---

### Task 5: 상세 모달 "공매도" 섹션 (UI)

**Files:**
- Modify: `raddit-astro/src/components/Dashboard.tsx`
  - 시그널 선언부: `fundError` 시그널(153행 부근) 아래
  - `openDetail`: `loadFundamentals(ticker);`(548행 부근) 다음 줄
  - `loadFundamentals` 함수(650행 부근) 아래에 `loadShort` 추가
  - 렌더: 기술적 분석 `sig-list` 닫는 `</ul>`(1125행 부근)과 `<h3 class="dlg-sub">레딧 게시물` 사이

**Interfaces:**
- Consumes: `/api/short?ticker=X` → Task 3 `ShortPayload` JSON. 기존 CSS 클래스 `ind-grid`/`ind`/`label`/`value`/`dlg-sub`/`dlg-note`/`dlg-status` 재사용 (신규 CSS 없음).
- Produces: 모달 내 "공매도" 섹션 — 잔고 %float(전월 대비 화살표)·숏 커버 소요일·전일 거래 비중, 기준일 병기.

- [ ] **Step 1: 시그널·로더 추가** — `fundError` 시그널 아래에:

```tsx
  // 공매도 (#76) — /api/short (Yahoo 격주 잔고 + FINRA 전일 거래 비중)
  interface ShortData {
    interest: { shares_short: number | null; shares_short_prior: number | null;
      short_ratio: number | null; short_pct_float: number | null;
      date_short_interest: number | null } | null;
    daily: { date: string; short_vol_pct: number } | null;
    error: string | null;
  }
  const [shortD, setShortD] = createSignal<ShortData | null>(null);
  const [shortLoading, setShortLoading] = createSignal(false);
```

`loadFundamentals` 함수 정의 아래에:

```tsx
  // ── 공매도 현황 ── loadFundamentals 와 동일 패턴. 실패해도 다른 패널 영향 없음.
  async function loadShort(ticker: string) {
    setShortD(null); setShortLoading(true);
    try {
      const res = await fetch(`/api/short?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (dlgTicker() !== ticker) return;
      if (!res.ok) throw new Error(data.error || res.status);
      setShortD(data);
    } catch {
      if (dlgTicker() !== ticker) return;
      setShortD({ interest: null, daily: null, error: "불러오기 실패" });
    } finally {
      if (dlgTicker() === ticker) setShortLoading(false);
    }
  }
```

`openDetail` 안 `loadFundamentals(ticker);` 다음 줄에 `loadShort(ticker);` 추가.

- [ ] **Step 2: 렌더 추가** — `sig-list` 닫는 `</ul>` 바로 뒤에:

```tsx
          <h3 class="dlg-sub">공매도 <span class="dlg-note">잔고: 격주 보고(~2주 지연) · 비중: 전일</span></h3>
          <Show when={shortLoading()}><p class="dlg-status">공매도 데이터 불러오는 중…</p></Show>
          <Show when={!shortLoading() && shortD()}>
            <Show when={shortD()!.interest || shortD()!.daily}
              fallback={<p class="dlg-status">공매도 데이터 불러오기 실패</p>}>
              <div class="ind-grid">
                <div class="ind">
                  <div class="label">공매도 잔고 / 유통주식{siAsOf() ? ` (기준 ${siAsOf()})` : ""}</div>
                  <div class="value">{shortD()!.interest?.short_pct_float != null
                    ? `${shortD()!.interest!.short_pct_float!.toFixed(1)}%${siTrend()}` : "-"}</div>
                </div>
                <div class="ind">
                  <div class="label">숏 커버 소요일</div>
                  <div class="value">{shortD()!.interest?.short_ratio != null
                    ? `${shortD()!.interest!.short_ratio!.toFixed(1)}일` : "-"}</div>
                </div>
                <div class="ind">
                  <div class="label">전일 공매도 거래 비중{shortD()!.daily ? ` (${finraMMDD(shortD()!.daily!.date)})` : ""}</div>
                  <div class="value">{shortD()!.daily ? `${shortD()!.daily!.short_vol_pct.toFixed(1)}%` : "-"}</div>
                </div>
              </div>
            </Show>
          </Show>
```

렌더 도우미 — `loadShort` 함수 아래에:

```tsx
  /** 잔고 보고 기준일 epoch sec → "MM/DD" (UTC — Yahoo 가 자정 UTC 로 준다) */
  const siAsOf = () => {
    const sec = shortD()?.interest?.date_short_interest;
    if (sec == null) return null;
    const d = new Date(sec * 1000);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  /** 전월 대비 잔고 증감 화살표 — 비교 불가면 빈 문자열 */
  const siTrend = () => {
    const si = shortD()?.interest;
    if (!si || si.shares_short == null || si.shares_short_prior == null) return "";
    return si.shares_short > si.shares_short_prior ? " ▲" : si.shares_short < si.shares_short_prior ? " ▼" : "";
  };
  /** FINRA 파일 날짜 "YYYYMMDD" → "MM/DD" */
  const finraMMDD = (d: string) => `${d.slice(4, 6)}/${d.slice(6, 8)}`;
```

- [ ] **Step 3: 타입 체크**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx astro check`
Expected: 0 errors.

- [ ] **Step 4: 브라우저 스모크** — dev 서버(3300) 기동 후 claude-in-chrome으로 `http://localhost:3300` → TSLA 검색 → 상세 모달에서 "공매도" 섹션 3개 지표·기준일 확인. 페니주식(대시보드 목록 아무거나)도 열어 결손 필드 `-` 확인.

- [ ] **Step 5: 커밋**

```bash
git add raddit-astro/src/components/Dashboard.tsx
git commit -m "feat(ui): 상세 모달에 공매도 섹션 추가"
```
(body: 잔고·커버일·전일 비중 3지표, 기준일 병기로 실시간 오해 방지. #76)

---

### Task 6: ⚡ 급등 뷰 "숏 비중" 컬럼 (UI)

**Files:**
- Modify: `raddit-astro/src/components/Dashboard.tsx`
  - `AlertRow` 인터페이스(95행 부근)
  - alerts 테이블 thead(1003행 부근)·빈 행 colspan(1008행 부근)·본문 행(1024행 부근)

**Interfaces:**
- Consumes: Task 4의 `/api/alerts` 응답 `short_vol_pct: number | null`.
- Produces: 거래량 컬럼 옆 "숏 비중" 컬럼 — `37%` / `-`, 40% 이상은 `pill down` 강조.

- [ ] **Step 1: 구현**

`AlertRow`에 필드 추가 (`last_price` 줄 위):

```tsx
    short_vol_pct: number | null;
```

thead의 `<th>거래량</th>` 뒤에 `<th>숏 비중</th>` 추가, 빈 행 `colspan="8"` → `colspan="9"`.

본문 `vol_ratio` td 뒤에:

```tsx
                      <td>{a.short_vol_pct != null
                        ? (a.short_vol_pct >= 40
                          ? <span class="pill down">{a.short_vol_pct.toFixed(0)}%</span>
                          : <span class="dim">{a.short_vol_pct.toFixed(0)}%</span>)
                        : <span class="dim">-</span>}</td>
```

- [ ] **Step 2: 타입 체크 + 전체 테스트**

Run(Bash): `cd /c/parkdohyun/raddit/raddit-astro && npx astro check && npm test`
Expected: 0 errors, 전부 PASS.

- [ ] **Step 3: 브라우저 스모크** — ⚡ 급등 탭에서 컬럼 9개 렌더 확인 (장외 시간이라 이력이 비어 있으면 빈 행 colspan 9만 확인).

- [ ] **Step 4: 커밋**

```bash
git add raddit-astro/src/components/Dashboard.tsx
git commit -m "feat(ui): 급등 뷰에 숏 비중 컬럼 추가"
```
(body: FINRA 전일 비중. 40%+ 강조로 숏 압력 신호만 — 별도 판정 로직 없음(스펙 범위 제외). #76)

---

## 완료 기준 (이슈 #76 체크리스트 대응)

- 페니주식·대형주 모두 지표 표시 + 결손 `-` — Task 5 Step 4에서 확인
- Yahoo 401/403 crumb 재발급 경로 — Task 1 구현 (fetchBidAsk 동일 패턴)
- 데이터 기준일 명시 — Task 5 (기준일·전일 날짜 병기)
- `astro check` + 단위 테스트 통과 — Task 6 Step 2 최종 확인

**범위 제외 (스펙 확정):** 스퀴즈 배지, FINRA Query API 이력, 스크리너 목록 컬럼.

**작업 후:** push·PR 생성은 사용자 지시 대기 (CONTRIBUTING — 명시적 지시 없이 원격 반영 금지).
