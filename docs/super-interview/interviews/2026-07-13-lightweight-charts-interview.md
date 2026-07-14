# Interview Log: TV Lightweight Charts 차트 교체

## Metadata
- Mode: quick
- Type: brownfield
- Baseline: qkrehgus714/raddit, branch dev, raddit-astro/src/components/Dashboard.tsx
- Topic: #37 자체 구현 Canvas 차트 → TradingView Lightweight Charts 교체

## Context Scan (자동 확인)

### 현재 차트 구조 (Dashboard.tsx L176-401)
- `drawChart(data)` — Canvas 2D 직접 렌더링, ~200줄
- 데이터 포맷: `{ points: [{t, o, h, l, c, v}], overlays: [{t, s20, s50, bu, bl}], range, prev_close, regular_start, regular_end }`
- 렌더링 요소: 캔들스틱, 거래량 바, 프리/애프터마켓 밴드, 이동평균/볼린저 오버레이, 기준선(점선), 그리드, X축, 현재가 태그
- `onChartMove()` — 십자선 + 툴팁 (OHLC, 거래량 표시)
- `chartState` — hover 좌표→인덱스→데이터 매핑
- `clearChart()` — 빈 상태/에러 메시지
- 60초 자동 갱신 (min range)

### API 엔드포인트 (변경 없음)
- `/api/detail?ticker=X&range=Y` → 차트 데이터 반환
- 데이터 포맷 유지, 프론트엔드만 교체

### Lightweight Charts v5 특징
- Apache-2.0, ~45KB gzip
- Candlestick, Histogram, Line, Area, Baseline 시리즈 내장
- Crosshair, zoom, pan, touch 자동 지원
- Price Line API (현재가 태그)
- Custom Series / Primitives (프리/애프터마켓 밴드 등 커스텀 렌더링)
- npm: `lightweight-charts`

## Round 1 — 교체 범위

### Question
현재 차트 기능 중 다음을 모두 동등하게 유지하면서 교체하려 한다:
1. 캔들스틱 + 거래량 바
2. 이동평균(20일/50일) + 볼린저밴드 오버레이
3. 프리/애프터마켓 밴드 (5분봉만)
4. 기준선 점선 (전일종가 또는 구간시작가)
5. 현재가 태그 (우측)
6. 십자선 + OHLC 툴팁 (hover)
7. X축 시간 라벨 (한국시간)
8. chart-meta 텍스트 (범위, 고가/저가 등)

범위에 빠뜨리거나 추가하고 싶은 게 있어?

### User Answer
(사용자가 이미 "TV Lightweight Charts로 결정하고 superpowers flow로 개발해줘"라고 지시했으므로, 범위는 위 8개 항목 전부 동등 유지가 기본)

### Interpretation / Decision
- 교체 범위 = 기존 기능 100% 동등 유지
- 신규 기능 (커스텀 지표 등)은 이 PR에서 제외, #37 이슈에 별도 체크리스트로 존재
- 데이터 API 변경 없음

### Remaining Ambiguity
- 없음 — ready for design

## Readiness Check
- Goal: ✅ Canvas 2D 차트 → Lightweight Charts 교체
- Constraints: ✅ 기존 기능 100% 동등, API 변경 없음, SolidJS 환경
- Outputs: ✅ Dashboard.tsx 차트 부분 교체, 빌드 성공, 라이브 확인
- Success Criteria: ✅ 8개 기능 동등, 번들 증가 최소, 빌드 성공
- Non-Goals: ✅ 커스텀 지표 플러그인 시스템 (후속), 드로잉 툴
- Context: ✅ brownfield, raddit-astro/

**Ambiguity: 0.05 — ready for design**
