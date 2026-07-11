"""
Reddit 게시물 수집 — stdlib urllib 기반.

★ 핵심: requests/httpx가 아니라 표준 라이브러리 urllib를 쓴다.
2026년 Reddit은 TLS 핸드셰이크 지문으로 클라이언트를 식별해 차단하는데,
stdlib urllib의 TLS 지문은 현재 통과한다 (이슈 #13 실측: 200, 15건).
requests로 바꾸면 지문이 달라져 차단될 수 있으므로 절대 바꾸지 말 것.
"""
from __future__ import annotations

import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

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
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        # 403/429 가 여기로 온다 — 차단 신호
        raise RedditError(f"Reddit 응답 {exc.code}") from exc
    except Exception as exc:  # timeout, URError 등
        raise RedditError(f"Reddit 요청 실패: {exc}") from exc

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
