# 종목별 공매도 현황 표시 — 설계 (#76)

- 날짜: 2026-07-18
- 이슈: [#76](https://github.com/qkrehgus714/raddit/issues/76)
- 범위: v1(Yahoo 공매도 잔고) + v2(FINRA 일별 공매도 거래 비중) 전부
- 표시 위치: 상세 모달 + ⚡ 급등 뷰

## 배경

페니주식 특성상 숏 스퀴즈·공매도 압력이 급등의 주요 동인인데 대시보드에 공매도
지표가 없다. 이슈 #76에서 무료 소스 2개를 실호출로 검증 완료:

1. **Yahoo v10 quoteSummary `defaultKeyStatistics`** — 기존 crumb 인증 재사용.
   FINRA 격주 보고 기반, ~2주 지연.
2. **FINRA Reg SHO 일별 파일** — `https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt`,
   무인증. 전 종목 단일 파일, 장 마감 후 저녁 게시 → 실사용은 전일 기준.

두 지표는 성격이 다르다(격주 잔고 스냅샷 vs 일별 거래 비중). UI에서 구분 표기하고
기준일을 명시해 실시간으로 오해하지 않게 한다.

## 접근 결정

**독립 엔드포인트 `/api/short` + 알림 응답 병기** (A안 채택).

- 기각: `/api/detail` 합침 — detail TTL(60~600s)이 격주 데이터에 안 맞아
  quoteSummary 호출 낭비. Yahoo 레이트리밋에 민감한 프로젝트라 부적합.
- 기각: `/api/fundamentals` 합침 — EDGAR 장애와 Yahoo 장애 격리가 흐려짐.

## 1. 업스트림 (`upstream.ts`)

### fetchShortInterest(ticker)

Yahoo v10 `quoteSummary/{ticker}?modules=defaultKeyStatistics` + crumb.
`fetchBidAsk`와 동일한 인증 패턴: `getYahooAuth()` 재사용, 401/403 시
`yahooAuth = null` 후 1회 재발급·재시도.

```ts
interface ShortInterest {
  shares_short: number | null;        // sharesShort.raw
  shares_short_prior: number | null;  // sharesShortPriorMonth.raw
  short_ratio: number | null;         // shortRatio.raw (days to cover)
  short_pct_float: number | null;     // shortPercentOfFloat.raw × 100 (%)
  date_short_interest: number | null; // dateShortInterest.raw (epoch sec, 기준일)
}
```

응답 파싱은 순수 함수 `parseShortInterest(raw)`로 분리(테스트 대상).
모든 필드는 결손 허용(null).

### fetchFinraShortVolume()

`CNMSshvol{YYYYMMDD}.txt` 다운로드·파싱. 형식은 파이프 구분:
`Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market`.

- ET 기준 당일부터 **최대 5영업일 거슬러** 시도 — 당일분은 저녁(~18시 ET) 게시라
  아직 없으면 404로 자연히 전일로 소급. 주말·휴일도 404로 건너뜀.
  날짜 후보 생성은 순수 함수 `finraDateCandidates(now)`로 분리(테스트 대상).
- 파싱도 순수 함수 `parseFinraShortVolume(text)`로 분리(테스트 대상).
- 반환: `{ date: "YYYYMMDD", map: Map<ticker, { short_vol_pct: number; total_volume: number }> }`
  - `short_vol_pct = ShortVolume / TotalVolume × 100`, TotalVolume 0이면 제외.

## 2. 서비스 (`services.ts`)

### getShortData(ticker)

`getFundamentals`와 동일한 장애 격리 패턴 — 에러는 `error` 필드로만, 다른
패널에 영향 없음.

```ts
interface ShortPayload {
  ticker: string;
  interest: up.ShortInterest | null;  // v1 — Yahoo, 격주
  daily: { date: string; short_vol_pct: number } | null; // v2 — FINRA, 전일
  error: string | null;               // 두 소스 모두 실패 시에만
  generated_at: string;
}
```

- Yahoo·FINRA를 `Promise.allSettled`로 병렬 — 한쪽 실패해도 나머지는 표시.
- `shortCache` TTL: 성공 12h(격주 데이터), 에러 60s(`ttlFor` 패턴).
- FINRA 전 종목 맵은 **모듈 레벨 별도 캐시**(성공 시 24h) —
  `getShortData`와 `/api/alerts` 라우트가 공유. 프로세스당 하루 1회 다운로드.
  로드 실패 시 null 반환(throw 아님) — 호출부는 결손 처리.

## 3. API 라우트

### /api/short?ticker=X (신규)

`fundamentals.ts`와 동일 구조: `TICKER_RE` 검증 → `getShortData` →
`jsonCached(payload, ttl, ttl)` (error 있으면 60s, 아니면 600s).

### /api/alerts (수정)

각 알림 직렬화 시 `short_vol_pct: number | null` 병합. FINRA 공유 캐시 맵
lookup만 수행(무비용). 맵 미로드·해당 티커 없음 → null. `spike.ts`의
`SpikeAlert` 타입·폴러 로직은 변경하지 않는다 — 라우트에서만 병합.

## 4. UI (`Dashboard.tsx`)

### 상세 모달 — "공매도" 섹션

`loadFundamentals`와 동일 패턴의 `loadShort(ticker)` 추가, `openDetail`에서
병렬 호출. 지표 목록(RSI 등) 아래 "공매도" 섹션:

| 표기 | 값 예시 | 소스 |
|---|---|---|
| 공매도 잔고 (float 대비) | `10.3%` + 전월 대비 증감 화살표 | Yahoo |
| 숏 커버 소요일 | `3.2일` | Yahoo |
| 전일 공매도 거래 비중 | `37.3% (07/17)` | FINRA |

- 기준일 명시: 잔고 줄에 `기준 06/30 · 격주 갱신`, 일별 비중에 날짜 병기.
- 결손 필드는 `-`. 두 소스 모두 실패 시 "공매도 데이터 불러오기 실패" 한 줄.

### ⚡ 급등 뷰 — 컬럼 추가

거래량 옆에 `숏 비중` 컬럼 1개: `short_vol_pct != null ? "37%" : "-"`.
40% 이상이면 강조 스타일. 별도 배지·판정 로직 없음.

## 5. 테스트

기존 `spike.test.ts` 스타일(순수 함수 단위 테스트):

- `parseShortInterest` — 정상·결손 필드(null)·빈 응답.
- `parseFinraShortVolume` — 정상 파일·헤더만·TotalVolume 0 행 제외.
- `finraDateCandidates` — 평일·주말·월요일(금요일 파일로 거슬러) 케이스.

## 6. 완료 기준 (이슈 체크리스트 반영)

- [ ] 페니주식·대형주 모두 지표 정상 표시, 결손 필드 `-` 처리
- [ ] Yahoo 401/403 crumb 재발급 경로에서 동작
- [ ] 데이터 기준일(지연) 명시 — 실시간 오해 방지
- [ ] `astro check` + 단위 테스트 통과

## 범위 제외

- 스퀴즈 후보 배지(#74 결합) — 후속 이슈로.
- FINRA Query API(이력 조회) — 미채택 (이슈 메모대로).
- 스크리너 목록 컬럼 — 종목당 quoteSummary 호출 부담으로 미채택.
