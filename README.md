# raddit — 레딧 페니주식 워치보드

레딧 주식 서브레딧(r/wallstreetbets, r/pennystocks 등)의 티커 언급량을 집계해
실제 페니주식($5 미만)만 걸러 보여주는 실시간 대시보드입니다.

**🔗 라이브 데모: https://raddit-gold.vercel.app**

**▶ [`raddit-next/`](./raddit-next) — Next.js 웹 서비스 (배포 버전, 여기가 본체)**

- 언급 순위 + 실시간 주가 스크리닝, 종목 클릭 시 캔들 차트(캔버스 직접 구현)
- 서버 계산 기술적 분석: RSI · MACD · 볼린저밴드 · 이동평균 · 거래량/수급 시그널 (한국어 요약)
- 3층 캐시 구조: CDN 엣지(`s-maxage` + SWR) → Next 데이터 캐시 → 인메모리(요청 합치기 · stale-if-error)

루트의 `server.py` / `penny_mentions.py` / `dashboard.html`은 표준 라이브러리만으로 만든
첫 버전(파이썬 로컬 서버)으로, 참고용으로 남겨두었습니다 — `python server.py`로 실행됩니다.

> 언급량은 관심도 지표일 뿐 투자 판단의 근거가 아닙니다. 페니주식은 변동성과 조작 위험이 큽니다.
