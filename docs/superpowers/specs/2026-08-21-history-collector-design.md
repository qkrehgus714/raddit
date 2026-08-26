# 언급·시세 이력 수집기 설계 ⚡️

날짜: 2026-08-21
상태: 구현 중
관련 이슈: [#112](https://github.com/qkrehgus714/raddit/issues/112)
브랜치: `feat/history-collector`

## 배경

raddit은 커뮤니티 언급 데이터를 **화면에 뿌리기만 하고 어디에도 저장하지 않는다.**

- ApeWisdom은 현재 스냅샷(`mentions`, `mentions_24h_ago`)만 준다. 과거 시계열이 없다.
- 서버 상태가 전부 인메모리다(`Map`·`globalThis`). 급등 알림조차 48시간 보존이 전부고
  (`spike.ts`), 재배포하면 통째로 사라진다.
- 저장소에 DB도, 영속 볼륨도 없다. 의존성은 5개뿐이다.

그래서 **"언급이 튄 다음 날 주가가 어떻게 됐나"를 확인할 데이터가 한 줄도 없다.**
커뮤니티 신호 기반 자동매매의 0단계가 이것이고, **데이터는 기다린 만큼만 쌓이므로**
전략 정의보다 먼저 시작한다.

## 설계 원칙

이 네 가지가 나머지 결정을 전부 끌고 간다.

1. **앱을 죽이지 않는다.** 수집기는 부가 기능이다. DB를 못 열든 업스트림이 실패하든
   **raddit 본체는 정상 동작해야 한다.** 볼륨 설정 전에 배포돼도 마찬가지다.
2. **의존성을 늘리지 않는다.** Node 24의 내장 `node:sqlite`를 쓴다 (플래그 없이 동작 확인).
   의존성 5개를 그대로 유지한다.
3. **재실행에 안전하다.** 같은 시각을 두 번 수집해도 행이 두 배가 되지 않는다.
4. **기존 코드를 다시 쓴다.** 상위 종목은 `fetchMentions`, 시세는 `fetchSpikeQuotes`.
   둘 다 이미 있고 배치 조회까지 된다. 새로 만드는 건 저장 계층뿐이다.

## 구조

```
middleware.ts
  ├── ensureSpikeWatch()        기존 — 90초 급등 감시
  └── ensureHistoryCollect()    신규 — 1시간 이력 수집   (둘 다 globalThis 가드로 1회만)

lib/db.ts          DB 열기 · 스키마 · 가용성 판정      ← 저장소를 아는 유일한 파일
lib/history.ts     스냅샷 수집 · 폴링 루프             ← 업스트림과 스키마를 잇는다
```

**`db.ts`가 저장소를 아는 유일한 지점이다.** `history.ts`는 "행을 넣는다"만 알고
파일 경로도 SQLite도 모른다. 나중에 Postgres로 갈아타거나 백테스트 하네스가 붙어도
`db.ts`만 바뀐다.

### db.ts

```ts
export function getDb(): DatabaseSync | null   // 못 열면 null, 던지지 않는다
export function isDbReady(): boolean
export function closeDb(): void                // 테스트용
```

- 경로는 `RADDIT_DB_PATH` (기본 `./data/raddit.db`). 디렉터리는 없으면 만든다.
- **열기 실패는 예외가 아니라 `null`이다.** 한 번 실패하면 그 사실을 기억하고
  매 주기 재시도하지 않는다 (로그 폭주 방지).
- 스키마는 열 때 `CREATE TABLE IF NOT EXISTS`로 보장한다. 마이그레이션 도구는 두지 않는다 —
  테이블 두 개짜리에 그건 과하다. 컬럼이 늘면 `ALTER TABLE`을 한 줄 추가한다.
- `PRAGMA journal_mode = WAL` — 수집 중에도 읽기가 막히지 않게.

### 스키마

```sql
CREATE TABLE IF NOT EXISTS mention_snap (
  ts               INTEGER NOT NULL,   -- epoch sec, 정시로 내림
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
  PRIMARY KEY (ts, ticker)
);

CREATE INDEX IF NOT EXISTS idx_mention_ticker ON mention_snap(ticker, ts);
CREATE INDEX IF NOT EXISTS idx_quote_ticker   ON quote_snap(ticker, ts);
```

**왜 테이블을 둘로 나눴나.** 언급과 시세는 출처도 실패 양상도 다르다. ApeWisdom이
살아 있는데 야후가 죽는 일이 흔하고, 그 반대도 있다. 한 테이블에 합치면 한쪽이
실패했을 때 행 전체를 버리거나 절반이 NULL인 행을 넣어야 한다. **나눠 두면 각각
들어간 만큼 남는다.**

**왜 `(ts, ticker)` 복합 PK인가.** 재실행 멱등성이 여기서 나온다. `INSERT OR REPLACE`가
같은 시각·같은 종목을 덮어쓰므로 수집이 두 번 돌아도 행이 늘지 않는다.
인덱스는 반대 순서 `(ticker, ts)`로 하나 더 둔다 — 백테스트 질의가
"이 종목의 시계열"이라 그 방향으로 훑는다.

**왜 `day_change_pct`를 시세에 넣나.** 급등 조사에서 드러난 것 —
15분 구간 변화율과 일간 등락률은 다른 값이고, 백테스트에는 일간이 필요하다.
`fetchSpikeQuotes`가 이미 부르는 응답에 있어 **추가 요청이 0**이다.
(이 필드를 `SpikeQuote`에 추가하는 것은 이 이슈에서 함께 한다.)

### ts 정규화

`ts = floor(now / 3600) * 3600`. **정시로 내린다.**

수집이 13:00:04에 돌든 13:00:57에 돌든 같은 `ts`가 되어야, 나중에
"t시점 언급 → t+24h 가격" 같은 조인이 시각 오차 없이 붙는다. 정규화하지 않으면
조인마다 시간 버킷을 다시 계산해야 하고, 재실행 멱등성도 깨진다.

### 수집 1회

```
collectOnce()
  1. fetchMentions("all-stocks")  →  상위 HISTORY.TOP_N(200) 종목
  2. mention_snap 에 INSERT OR REPLACE          ← 여기까지 성공하면 언급은 남는다
  3. fetchSpikeQuotes(위 티커들)
  4. quote_snap 에 INSERT OR REPLACE
```

2단계와 4단계를 **각각 트랜잭션으로 감싼다.** 3단계가 실패해도 언급은 이미 저장돼 있다.
"들어간 만큼 남는다"는 위 원칙이 여기서 실현된다.

### 폴링 루프

`ensureSpikeWatch`와 같은 패턴을 쓴다 — 이미 검증된 모양이고, 두 폴러가 다르게 생기면
읽는 사람이 매번 둘을 비교해야 한다.

- `globalThis.__radditHistoryCollect` 가드로 프로세스당 1개
- 기동 10초 뒤 첫 수집 (급등 폴러가 5초라 겹치지 않게)
- 주기 `POLL_MS = 3_600_000` (1시간)
- 연속 3회 실패 시 10분 백오프
- `HISTORY_COLLECT=0`으로 비활성 (`SPIKE_WATCH=0`과 같은 관례)
- **장 시간 게이트를 두지 않는다.** 급등 감시와 다른 점이다 —
  레딧 언급은 장이 닫혀도 계속 쌓이고, 주말 언급이야말로 월요일 시초가와 붙여
  볼 가치가 있는 데이터다.

## 크기 (실측)

상위 200종목 × 2테이블 × 24회/일 ≈ **9,600행/일 · 350만행/년**.

30일치(288,000행)를 실제로 넣어 재보니 **24.0 MB · 행당 87 B**였다(인덱스 포함).
연 환산 **약 290 MB**. 처음 추정했던 "연 200MB 안쪽"보다 크다 — 인덱스 두 개와
페이지 오버헤드가 추정에 안 들어가 있었다.

SQLite가 부담 없이 받는 규모이고 Railway 볼륨 최소 용량으로 수년치가 들어가지만,
**무한히 쌓이는 구조라는 점은 기억해 둬야 한다.** 보존 정책(예: 2년 초과 삭제)은
지금 넣지 않는다 — 데이터가 아까운 단계이고, 필요해지는 시점이 한참 뒤다.

## 배포

- `.gitignore`에 `data/` 추가
- Railway 볼륨을 마운트하고 `RADDIT_DB_PATH`를 그 경로 아래로 지정
  (**대시보드 작업이라 담당자가 직접 수행** — PR 본문에 값 명시)
- **볼륨 설정 전에 배포돼도 앱은 정상 동작한다.** 수집기만 조용히 꺼진다.

## 테스트

`node:sqlite`는 `:memory:`를 지원하므로 파일 없이 전부 검증된다.

- 스키마가 생성되고 두 테이블이 존재한다
- 같은 `(ts, ticker)`를 두 번 넣어도 행이 하나다 (멱등성)
- `ts`가 정시로 내려간다 (13:00:04 · 13:59:59 → 같은 값)
- 시세 조회가 실패해도 `mention_snap`은 남는다 (부분 실패 내성)
- DB를 못 열면 `getDb()`가 `null`이고 수집기는 조용히 건너뛴다
- 업스트림이 던지면 그 주기만 건너뛰고 다음 주기에 재시도한다

## 하지 않는 것

- **자동매매 봇** — raddit은 공개 배포라 주문 권한이 붙은 코드가 여기 살면 안 된다.
  봇은 이 API를 소비하는 별도 비공개 프로세스다.
- **급등 알림 이력을 DB로 옮기는 일** — 이 저장 계층 위에서 풀 수 있지만 별개 이슈다.
- **백테스트 하네스** — 데이터가 쌓인 뒤 별개 이슈로.
- **조회 API** — 지금은 쌓기만 한다. 읽는 쪽은 소비자가 정해진 뒤에 만든다.

## 후속

① KIS 모의투자 연결 → ② 백테스트 하네스 → ③ 모의투자 자동매매 → ④ 실계좌 소액.
각각 별도 이슈.
