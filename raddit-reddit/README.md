# raddit-reddit

Reddit 게시물 수집 전용 **RPC 마이크로서비스**. `raddit-next`(Next.js/Vercel)가 호출한다.

## 왜 존재하나

Reddit은 Node.js(undici)의 **TLS 핸드셰이크 지문**으로 클라이언트를 식별해 봇으로
차단한다 (이슈 #13). Vercel 서버리스 함수에서 Reddit 호출 시 `403`/`429` 발생.
반면 **표준 라이브러리 `urllib`** 의 TLS 지문은 현재 통과한다. 이 서비스는 urllib로
Reddit RSS를 수집해 JSON으로 돌려주고, Vercel 함수는 이것을 HTTP RPC로 호출한다.

```
[Vercel] raddit-next /api/posts ──RPC──▶ [여기] /rpc/reddit-posts ──▶ Reddit RSS
```

> ⚠️ **미검증 리스크**: urllib의 residential IP 통과는 확인됐으나, 데이터센터 IP
> (Railway 등)에서도 통과하는지는 배포 후 즉시 검증해야 한다. 실패 시 이슈 #13의
> 방안 C(홈서버 크론)로 후퇴.

## ★ 절대 바꾸지 말 것

`requests`/`httpx` 로 전환 금지. 2026 Reddit 정책은 `requests` 도 지문 차단 대상으로
식별한다 ([참고](https://dev.to/tonywangca/why-reddit-blocked-unauthenticated-json-in-2026-and-how-to-still-get-reddit-data-58b9)).
**stdlib `urllib`** 가 통과하는 유일한 검증된 클라이언트다.

## 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/healthz` | 헬스체크 → `{"status":"ok"}` |
| `GET` | `/rpc/reddit-posts?ticker=GME&limit=15` | 게시물 목록 → `{"ticker","posts":[...]}` |

`posts[]` 형태: `{title, url, subreddit, ts}`

인증: 환경변수 `RPC_KEY` 설정 시 요청 헤더 `X-RPC-Key` 일치 필요 (미설정 시 생략).

## 로컬 실행

```bash
cd raddit-reddit
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
# 확인
curl 'http://localhost:8000/rpc/reddit-posts?ticker=GME'
```

## 컨테이너

```bash
docker build -t raddit-reddit .
docker run -p 8000:8000 -e RPC_KEY=secret raddit_reddit
```

## 배포 (Railway 등)

1. 이 디렉토리(`raddit-reddit/`)를 루트로 배포 — `Dockerfile` 감지
2. 환경변수: `PORT`(자동), `RPC_KEY`(선택)
3. 배포 후 `https://<도메인>/rpc/reddit-posts?ticker=GME` 로 403/429 없이 200 오는지 즉시 검증

## Next.js 연동

`raddit-next` 쪽 환경변수:
```
REDDIT_RPC_URL=https://<배포된-도메인>
REDDIT_RPC_KEY=<RPC_KEY 와 동일>
```
`lib/upstream.ts` 의 `fetchRedditPosts()` 가 이 서비스를 호출한다.
