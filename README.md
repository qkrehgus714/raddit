# raddit — 레딧 페니주식 워치보드

레딧 주식 서브레딧(r/wallstreetbets, r/pennystocks 등)의 티커 언급량을 집계해
실제 페니주식($5 미만)만 걸러 보여주는 실시간 대시보드입니다.

## 라이브 데모

| 서비스 | URL |
|--------|-----|
| 웹 대시보드 | <https://raddit-web-production.up.railway.app> |
| Reddit 수집 RPC | <https://raddit-reddit-production.up.railway.app/healthz> |

## 모노레포 구조

```
raddit/
├── raddit-next/       # Next.js 웹 서비스 — 대시보드 본체
├── raddit-reddit/     # Python RPC 마이크로서비스 — Reddit 게시물 수집
├── .github/workflows/ # Railway 자동 배포 GitHub Actions
├── server.py          # 초기 버전 (파이썬 로컬 서버, 참고용)
└── CONTRIBUTING.md    # 기여 가이드라인
```

### raddit-next (Next.js 웹)

- 언급 순위 + 실시간 주가 스크리닝, 종목 클릭 시 캔들 차트(캔버스 직접 구현)
- 서버 계산 기술적 분석: RSI · MACD · 볼린저밴드 · 이동평균 · 거래량/수급 시그널 (한국어 요약)
- 3층 캐시 구조: CDN 엣지(`s-maxage` + SWR) → Next 데이터 캐시 → 인메모리(요청 합치기 · stale-if-error)
- 버전 표시 배지 + GitHub Releases 기반 변경이력 뷰어

### raddit-reddit (Python RPC)

Next.js(Node undici)의 TLS 지문이 Reddit에 차단되는 문제를 해결하기 위해 분리된 마이크로서비스입니다.
stdlib `urllib`만 사용(외부 HTTP 클라이언트 없이)하여 Reddit RSS를 수집하고 JSON으로 반환합니다.

- `GET /healthz` — 헬스 체크
- `GET /rpc/reddit-posts?ticker=GME&limit=20` — 티커별 게시물 수집
- `X-RPC-Key` 공유 시크릿 인증 (`hmac.compare_digest` 상수시간 비교)
- non-root 컨테이너 실행 + `PYTHONUNBUFFERED=1`

## 배포 아키텍처

```
GitHub (main/dev push)
  └── GitHub Actions (Railway Deploy)
       ├── raddit-next/ 변경 시 → raddit-web 서비스 재배포
       └── raddit-reddit/ 변경 시 → raddit-reddit 서비스 재배포
```

- **플랫폼:** Railway (단일 프로젝트, 서비스 2개)
- **자동 배포:** GitHub Actions가 main/dev push 감지 → 변경 경로별로 해당 서비스만 배포
- **시크릿 관리:** `RAILWAY_API_TOKEN` GitHub Secret 사용

## 로컬 실행

### 웹 (raddit-next)

```bash
cd raddit-next
npm install
npm run dev    # http://localhost:3000
```

### Reddit RPC (raddit-reddit)

```bash
cd raddit-reddit
pip install -r requirements.txt
uvicorn app:app --reload --port 8000    # http://localhost:8000
```

> 환경변수는 각 서비스 디렉토리의 `.env.example`을 참조하세요.

## 이전 버전

루트의 `server.py` / `penny_mentions.py` / `dashboard.html`은 표준 라이브러리만으로 만든
첫 버전(파이썬 로컬 서버)으로, 참고용으로 남겨두었습니다 — `python server.py`로 실행됩니다.

---

> 언급량은 관심도 지표일 뿐 투자 판단의 근거가 아닙니다. 페니주식은 변동성과 조작 위험이 큽니다.
