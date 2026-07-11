"""
raddit-reddit — Reddit 게시물 수집 전용 마이크로서비스 (RPC).

Next.js(Vercel)는 Node(undici)의 TLS 지문이 Reddit에 차단되어 게시물을 가져오지
못한다. 이 서비스는 stdlib urllib(TLS 지문 통과)로 Reddit RSS를 수집해 JSON으로
돌려준다. Vercel 함수는 이 서비스를 HTTP RPC로 호출한다.

엔드포인트
  GET /rpc/reddit-posts?ticker=GME&limit=15  → {"ticker","posts":[...]}
  GET /healthz                               → {"status":"ok"}

실행
  uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}

인증(선택) — RPC_KEY 환경변수를 설정하면 요청 헤더 X-RPC-Key 와 비교한다.
"""
from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Query

from reddit import RedditError, fetch_reddit_posts

app = FastAPI(
    title="raddit-reddit",
    description="Reddit 게시물 수집 RPC 마이크로서비스 (이슈 #13)",
    version="0.1.0",
)

_RPC_KEY = os.environ.get("RPC_KEY", "").strip()


def _check_key(x_rpc_key: Optional[str]) -> None:
    """RPC_KEY 가 설정된 경우 헤더 일치 검사. 미설정 시 인증 생략(개발/내부망)."""
    if _RPC_KEY and (x_rpc_key or "") != _RPC_KEY:
        raise HTTPException(status_code=401, detail="invalid RPC key")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/rpc/reddit-posts")
def reddit_posts(
    ticker: str = Query(..., min_length=1, max_length=16),
    limit: int = Query(15, ge=1, le=50),
    x_rpc_key: Optional[str] = Header(None, alias="X-RPC-Key"),
) -> dict:
    _check_key(x_rpc_key)
    try:
        posts = fetch_reddit_posts(ticker, limit=limit)
    except RedditError as exc:
        # Reddit 차단(403/429 등)은 게이트웨이 오류로 — 호출측에서 폴백 처리
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ticker": ticker.strip().upper(), "posts": posts}
