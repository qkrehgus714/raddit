"""
Reddit 게시물 수집 — stdlib urllib 기반.

★ 핵심: requests/httpx가 아니라 표준 라이브러리 urllib를 쓴다.
2026년 Reddit은 TLS 핸드셰이크 지문으로 클라이언트를 식별해 차단하는데,
stdlib urllib의 TLS 지문은 현재 통과한다 (이슈 #13 실측: 200, 15건).
requests로 바꾸면 지문이 달라져 차단될 수 있으므로 절대 바꾸지 말 것.
"""
from __future__ import annotations

import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

# Reddit 은 연속 요청에 429(Too Many Requests) 를 건넨다. TLS 지문 차단(403)은
# 아니므로, 잠시 대기 후 재시도하면 통과한다. 운영 환경에선 Next.js 쪽 10분
# 캐시로 실제 호출이 드물어 한계에 닿기 어렵지만, 버스트 시 폴백용으로 둔다.
_MAX_RETRIES = 3
_RETRY_BASE = 1.5  # 초 (지수 백오프 베이스)

# 동시·연속 요청을 Reddit 이 429 로 막으므로, 전역 최소 간격으로 직렬화한다.
# uvicorn 은 동기 엔드포인트를 스레드풀에서 돌리므로 락이 필요하다.
_MIN_INTERVAL = 2.0  # 초 — Reddit 요청 간 최소 간격
_req_lock = threading.Lock()
_last_req = 0.0


def _throttle() -> None:
    """Reddit 요청 직전에 호출 — 직전 요청으로부터 _MIN_INTERVAL 보다 짧으면 대기."""
    global _last_req
    with _req_lock:
        now = time.monotonic()
        wait = _MIN_INTERVAL - (now - _last_req)
        if wait > 0:
            time.sleep(wait)
        _last_req = time.monotonic()

# 레딧 JSON API는 비로그인 요청을 403으로 차단하지만 RSS 검색 피드는 (현재) 열려 있다.
REDDIT_SEARCH_SUBS = "pennystocks+wallstreetbets+stocks+investing+Shortsqueeze+smallstreetbets"
REDDIT_RSS_URL = (
    "https://www.reddit.com/r/{subs}/search.rss"
    "?q={q}&restrict_sr=on&sort=new&t=month&limit={limit}"
)
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_TIMEOUT = 15  # 초

_ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}


def _retry_after(exc: urllib.error.HTTPError, attempt: int) -> float:
    """429 응답의 Retry-After 헤더(초) 를 우선, 없으면 지수 백오프."""
    header = exc.headers.get("Retry-After") if exc.headers else None
    if header:
        try:
            return float(header)
        except ValueError:
            pass
    return _RETRY_BASE * (2 ** attempt)


class RedditError(Exception):
    """Reddit 호출 실패 — 상위(RPC 레이어)에서 502로 매핑."""


def fetch_reddit_posts(ticker: str, limit: int = 15) -> list[dict]:
    """주식 서브레딧들에서 티커를 검색한 최근 1개월 게시물 (Atom 피드 파싱)."""
    ticker = (ticker or "").strip().upper()
    if not ticker:
        raise RedditError("ticker 가 비어 있습니다")

    url = REDDIT_RSS_URL.format(
        subs=REDDIT_SEARCH_SUBS,
        q=urllib.parse.quote(f'"{ticker}"'),
        limit=limit,
    )
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    body = b""
    for attempt in range(_MAX_RETRIES + 1):
        _throttle()
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                body = resp.read()
                break
        except urllib.error.HTTPError as exc:
            # 429 는 과도 요청 — Retry-After(초) 만큼, 또는 지수 백오프로 대기 후 재시도.
            # 403 은 TLS/IP 차단 신호라 재시도 의미 없음 — 즉시 에러로.
            if exc.code == 429 and attempt < _MAX_RETRIES:
                wait = _retry_after(exc, attempt)
                time.sleep(wait)
                continue
            raise RedditError(f"Reddit 응답 {exc.code}") from exc
        except Exception as exc:  # timeout, URLError 등
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_BASE * (attempt + 1))
                continue
            raise RedditError(f"Reddit 요청 실패: {exc}") from exc
    else:
        raise RedditError("Reddit 요청 재시도 전부 실패")

    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise RedditError(f"RSS 파싱 실패: {exc}") from exc

    posts: list[dict] = []
    for entry in root.findall("a:entry", _ATOM_NS):
        link = entry.find("a:link", _ATOM_NS)
        cat = entry.find("a:category", _ATOM_NS)
        try:
            ts = int(
                datetime.fromisoformat(
                    entry.findtext("a:updated", "", _ATOM_NS)
                ).timestamp()
            )
        except ValueError:
            ts = None
        posts.append(
            {
                "title": entry.findtext("a:title", "", _ATOM_NS),
                "url": link.get("href") if link is not None else None,
                "subreddit": cat.get("label") if cat is not None else None,
                "ts": ts,
            }
        )
    posts.sort(key=lambda p: p["ts"] or 0, reverse=True)
    return posts
