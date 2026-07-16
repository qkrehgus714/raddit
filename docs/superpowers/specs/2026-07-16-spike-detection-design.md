# 뉴스 선행 급등 실시간 탐지 — 설계 (#74)

2026-07-16 · 브레인스토밍 확정본
(개정: 최초안은 raddit-next(Next.js) 기준으로 작성됐으나, dev가 raddit-astro로
마이그레이션됨에 따라 파일 경로·기동 방식을 Astro 기준으로 현행화)

## 목표

호재 뉴스가 보도되기 전에 가격·거래량이 먼저 움직이는 순간을 포착한다.
레딧 언급 상위 종목(~120개)을 서버가 장 시간대에 주기 폴링해, 이상 급등을
감지하면 이력 탭에 시간순으로 기록한다. 감지 시점에 최근 뉴스가 없으면
"뉴스 없음(선행 가능성)"으로 강조한다.

## 스코프 결정

- 감시 범위: ApeWisdom 언급 상위 ~120종목 (기존 수집 파이프라인 재활용).
  전 시장 스캔은 무료 데이터소스로 불가 → 범위 밖.
- 수집 방식: 서버 백그라운드 폴링 (Railway 상시 서버).
  ※ 과거 "대시보드 자동갱신 미채택" 결정은 프론트 폴링에 대한 것 —
  서버 내부 폴링은 별개로 사용자가 승인함.
- 표시: 감지 이력 탭 (실시간 배너·푸시 알림은 범위 밖).
- 이력 저장: 인메모리 (재배포 시 소실 허용). 영속화는 검증 후 후속 이슈.
- 후속 분리: "지표 기반 상승 후보 랭킹"은 별도 기능으로 이번 범위 밖.

## 아키텍처

```
src/middleware.ts (모든 요청에서 ensureSpikeWatch() 호출 — globalThis 가드로
첫 요청 시 1회만 기동. Astro node standalone은 Next instrumentation 같은
부팅 훅이 없어 lazy-start 채택)
   └─ src/lib/spike.ts 폴링 루프 — 장 시간대(ET 4:00~20:00 평일)만 90초 간격
        1. fetchMentions() → 감시 대상 상위 120티커
        2. fetchSpikeQuotes(tickers) — v7 quote 60개 청크
           (신규, upstream.ts — 기존 attachBidAskBatch의 crumb 인증·청크 패턴 재사용)
        3. 티커별 링버퍼에 스냅샷 push (시각·유효가격·누적거래량·marketState)
        4. judgeSpike() 통과 → fetchNews()로 뉴스 유무 확인 → 알림 이력 기록
        5. 기존 알림들의 last_price 갱신 (같은 배치 응답 재사용, 무비용)
```

### 컴포넌트

| 단위 | 책임 | 의존 |
|---|---|---|
| `src/lib/spike.ts` | 링버퍼·감지 판정(순수 함수)·알림 이력·폴링 루프 | upstream.ts |
| `src/lib/upstream.ts` 추가분 | `parseSpikeQuote()`(순수)·`fetchSpikeQuotes()` — v7 quote 배치 | Yahoo v7 |
| `src/pages/api/alerts.ts` | 이력 조회 API | spike.ts |
| `src/components/Dashboard.tsx` | viewMode "alerts" — "⚡ 급등" 뷰 | /api/alerts |
| `src/middleware.ts` | 폴러 기동 (신규 파일, 첫 요청 시 1회) | spike.ts |

## 감지 알고리즘 (v1)

폴링마다 각 티커에 대해 판정. 임계값은 상수로 모아 튜닝 가능하게.

1. **가격 급등**: 최근 15분 상승률 ≥ +3%
   (장중 regularMarketPrice, 프리·애프터는 pre/postMarket 가격)
2. **거래량 폭증** (정규장만 — 장외 거래량은 Yahoo 미제공):
   최근 15분 누적거래량 증분 ≥ `averageDailyVolume10Day / 390분 × 15분 × 5배`
3. **노이즈 컷**: 10일 평균 거래량 5만주 미만 초저유동성 제외
4. **쿨다운**: 같은 티커 60분 내 재감지 금지

판정: 정규장 = 1 AND 2. 장외 = 1만 적용하되 임계 +5%로 상향.

감지 시 `fetchNews(ticker)`로 최근 12시간 내 기사 유무 확인:
- 없음 → `news: "none"` — "뉴스 없음(선행 가능성)" 배지
- 있음 → `news: "recent"` + 최신 기사 제목·링크
- 조회 실패 → `news: "unknown"` — "뉴스 확인 실패" 중립 배지 (실패를 "없음"으로
  단정하지 않는다)

## 데이터 구조

```ts
interface SpikeSnapshot { t: number; price: number; cumVol: number | null;
  state: string | null; }            // 티커당 링버퍼 최근 30개(~45분)

interface SpikeAlert {
  ticker: string; name: string | null;
  detected_at: number;               // epoch sec
  price: number;                     // 감지 시점 가격
  change_pct: number;                // 15분 상승률
  vol_ratio: number | null;          // 거래량 배율 (장외 감지는 null)
  market_state: string;              // REGULAR / PRE / POST
  news: "none" | "recent" | "unknown";
  news_title: string | null; news_url: string | null;
  last_price: number | null;         // 폴러가 매 주기 갱신
  since_pct: number | null;          // 감지가 대비 현재 등락
}
```

이력: 최신순 배열, 48시간 경과분 제거, 최대 200건.

## API

`GET /api/alerts` → `{ generated_at, market_open: boolean, alerts: SpikeAlert[] }`

- 캐시 불필요 (인메모리 배열 직렬화만).
- `market_open`은 프론트 빈 상태 문구용 ("미국 장 외 시간").

## UI — Dashboard.tsx viewMode "alerts" ("⚡ 급등" 뷰)

- 기존 목록/스크리너 뷰 토글에 세 번째 모드로 추가. 행: 감지 시각(KST) ·
  티커/종목명 · 세션 배지(프리/정규/애프터) · 상승률 · 거래량 배율 ·
  뉴스 배지("뉴스 없음" 강조 / "뉴스 있음"은 기사 제목 링크 / "확인 실패") ·
  감지가→현재가(감지 후 등락).
- 행 클릭 → 기존 상세 모달(openDetail) 재사용.
- 알림 뷰가 열려 있는 동안 60초 간격 갱신 (상세 모달 분 탭의 60초 갱신 관례와 동일).
- 빈 상태: 장중이면 "아직 감지 없음", 장외면 "미국 장 외 시간" 안내.

## 에러 처리

- 폴링 사이클 전체 try/catch — 실패가 서버에 전파되지 않음.
- 연속 3회 실패 시 10분 백오프 후 재개.
- dev 핫리로드·미들웨어 다중 호출 대비 `globalThis` 가드로 폴러 중복 기동 방지.
- `SPIKE_WATCH=0` 환경변수로 폴러 비활성화 (필요시 dev 환경 끄기).
- Yahoo 인증 만료는 기존 crumb 재발급 경로 재사용.

## 테스트

- 테스트 러너: vitest 도입 (Astro/Vite 생태계 표준, 현재 테스트 인프라 없음).
- `judgeSpike(snapshots, avgVol10d, now)` 순수 함수 유닛 테스트:
  급등 / 완만 상승 / 거래량만 폭증 / 장외(+5%) / 저유동성 컷 / 이력 부족.
- `isMarketWindow(date)` — 평일 장중/장외/주말, `parseSpikeQuote()` — 세션별 유효가.
- 실전 검증: dev 배포 후 장중 감지 로그·이력 탭 확인.

## 범위 밖 (후속 이슈 후보)

- 이력 영속화 (Railway 볼륨) — 장기 회고·적중률 통계(#69 연계)
- 브라우저 푸시 알림
- 지표 기반 상승 후보 랭킹 (별도 브레인스토밍)
