# 레딧 페니주식 워치보드

레딧 주식 서브레딧(r/wallstreetbets, r/pennystocks 등)의 티커 언급량을 집계해
실제 페니주식($5 미만)만 걸러 보여주는 실시간 대시보드입니다.
종목을 클릭하면 캔들 차트, 기술적 분석(RSI·MACD·볼린저밴드), 관련 레딧 게시물과 뉴스를 볼 수 있습니다.

## 기술 스택

- **Next.js (App Router) + TypeScript** — API Route Handler 4개가 ApeWisdom·Yahoo Finance·레딧 RSS를
  프록시(CORS 우회)하고, 기술 지표를 서버에서 계산해 내려줍니다.
- **Vanilla JS 프런트엔드** — 프레임워크 없이 캔버스로 직접 그리는 캔들스틱 차트(이동평균·볼린저밴드
  오버레이, 프리·애프터마켓 음영, 크로스헤어 툴팁 포함). 외부 차트 라이브러리 0개.

## 3층 캐시 구조

외부 API(ApeWisdom·Yahoo)는 느리고 요청 제한이 있어, 캐시를 3층으로 겹쳐 방어합니다.

| 층 | 위치 | 역할 |
|---|---|---|
| ① CDN 엣지 캐시 | `Cache-Control: s-maxage` + `stale-while-revalidate` | 같은 쿼리는 서버리스 함수까지 오지도 않고 엣지에서 응답 |
| ② Next 데이터 캐시 | `fetch(..., { next: { revalidate } })` | 업스트림 호출 결과를 인스턴스 간 공유 — 콜드 스타트에도 유효 |
| ③ 인메모리 캐시 | `lib/cache.ts` (TTL + 요청 합치기 + stale 서빙) | 캐시 만료 순간 요청이 몰려도 업스트림 호출은 1번(coalescing), 업스트림 장애 시 옛 값으로 버팀(stale-if-error) |

## API

| 엔드포인트 | 설명 | TTL |
|---|---|---|
| `GET /api/data?filter=&max_price=&min_mentions=` | 언급 순위 + 주가 스크리닝 | 2분 |
| `GET /api/detail?ticker=&range=` | 차트 시계열 + 기술적 분석 | 1분(1D) / 5분 |
| `GET /api/posts?ticker=` | 레딧 게시물 + 뉴스 | 10분 |
| `GET /api/search?q=` | 티커·회사명 검색 | 10분 |

## 실행

```bash
npm install
npm run dev   # http://localhost:3000
```

> 언급량은 관심도 지표일 뿐 투자 판단의 근거가 아닙니다. 페니주식은 변동성과 조작 위험이 큽니다.
