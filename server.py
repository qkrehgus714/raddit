"""레딧 페니주식 로컬 대시보드 서버.

브라우저 → localhost → 이 서버가 ApeWisdom·Yahoo Finance를 대신 호출(CORS 우회).

사용법:
    python server.py          # http://localhost:8000
    python server.py 8080     # 포트 지정
"""
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import penny_mentions as pm

BASE_DIR = Path(__file__).parent
CACHE_TTL = 120  # 초 — 새로고침 연타로 API를 두드리지 않게 잠깐 캐시
PRICE_LOOKUP_LIMIT = 120

_cache: dict[str, tuple[float, dict]] = {}
_detail_cache: dict[str, tuple[float, dict]] = {}
_daily_cache: dict[str, tuple[float, dict]] = {}
_posts_cache: dict[str, tuple[float, dict]] = {}
_search_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()

TICKER_RE = re.compile(r"[A-Z0-9.\-]{1,12}")
DAILY_TTL = 600   # 분석용 1년 일봉 캐시 (초)
POSTS_TTL = 600   # 레딧·뉴스 캐시 (초) — 비로그인 레딧은 요청 제한이 빡빡함
POSTS_ERR_TTL = 60  # 일부 실패한 응답은 짧게만 캐시
SEARCH_TTL = 600  # 심볼 검색 캐시 (초)


def build_payload(filter_name: str, max_price: float, min_mentions: int) -> dict:
    items = [it for it in pm.fetch_mentions(filter_name) if it["mentions"] >= min_mentions]
    candidates = items[:PRICE_LOOKUP_LIMIT]
    pm.attach_quotes(candidates)
    if max_price > 0:
        rows = [it for it in candidates
                if it.get("quote") and it["quote"]["price"] < max_price]
    else:
        rows = candidates
    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "filter": filter_name,
        "max_price": max_price,
        "scanned": len(items),
        "items": rows,
    }


def get_payload(filter_name: str, max_price: float, min_mentions: int) -> dict:
    key = f"{filter_name}|{max_price}|{min_mentions}"
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    payload = build_payload(filter_name, max_price, min_mentions)
    with _lock:
        _cache[key] = (time.time(), payload)
    return payload


def get_daily(ticker: str) -> dict:
    """분석 지표 계산용 1년 일봉 (티커당 10분 캐시)."""
    with _lock:
        hit = _daily_cache.get(ticker)
        if hit and time.time() - hit[0] < DAILY_TTL:
            return hit[1]
    data = pm.fetch_chart(ticker, "1y")
    with _lock:
        _daily_cache[ticker] = (time.time(), data)
    return data


def build_detail(ticker: str, rng: str) -> dict:
    chart = pm.fetch_chart(ticker, rng)
    daily = get_daily(ticker)
    meta = chart["meta"]
    regular = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    return {
        "regular_start": regular.get("start"),
        "regular_end": regular.get("end"),
        "ticker": ticker,
        "range": rng,
        "name": meta.get("shortName") or meta.get("longName"),
        "currency": meta.get("currency"),
        "exchange": meta.get("exchangeName"),
        "timezone": meta.get("exchangeTimezoneName"),
        "price": meta.get("regularMarketPrice"),
        "prev_close": meta.get("chartPreviousClose") or meta.get("previousClose"),
        "points": chart["points"],
        # 이동평균·볼린저밴드 오버레이 — 봉 간격이 일봉인 범위에서만 의미가 있음
        "overlays": (pm.compute_overlays(daily["points"])
                     if pm.RANGE_INTERVAL[rng] == "1d" else None),
        "analysis": pm.analyze(daily["points"], daily["meta"]),
        "generated_at": datetime.now().strftime("%H:%M:%S"),
    }


def build_posts(ticker: str) -> dict:
    """레딧 게시물 + 뉴스를 병렬로 수집. 한쪽이 실패해도 나머지는 반환."""
    out = {"ticker": ticker, "reddit": [], "news": [],
           "reddit_error": None, "news_error": None,
           "generated_at": datetime.now().strftime("%H:%M:%S")}
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_reddit = pool.submit(pm.fetch_reddit_posts, ticker)
        f_news = pool.submit(pm.fetch_news, ticker)
    try:
        out["reddit"] = f_reddit.result()
    except Exception as exc:
        out["reddit_error"] = str(exc)
    try:
        out["news"] = f_news.result()
    except Exception as exc:
        out["news_error"] = str(exc)
    return out


def get_posts(ticker: str) -> dict:
    with _lock:
        hit = _posts_cache.get(ticker)
        if hit and time.time() - hit[0] < (
                POSTS_TTL if not (hit[1]["reddit_error"] or hit[1]["news_error"])
                else POSTS_ERR_TTL):
            return hit[1]
    payload = build_posts(ticker)
    with _lock:
        _posts_cache[ticker] = (time.time(), payload)
    return payload


def get_search(query: str) -> dict:
    key = query.lower()
    with _lock:
        hit = _search_cache.get(key)
        if hit and time.time() - hit[0] < SEARCH_TTL:
            return hit[1]
    payload = {"query": query, "items": pm.search_symbols(query)}
    with _lock:
        _search_cache[key] = (time.time(), payload)
    return payload


def get_detail(ticker: str, rng: str) -> dict:
    key = f"{ticker}|{rng}"
    ttl = 60 if rng == "1d" else 300  # 1D는 준실시간으로 자주 갱신
    with _lock:
        hit = _detail_cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    payload = build_detail(ticker, rng)
    with _lock:
        _detail_cache[key] = (time.time(), payload)
    return payload


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self.send_file("dashboard.html", "text/html; charset=utf-8")
        elif parsed.path == "/api/data":
            self.handle_api(urllib.parse.parse_qs(parsed.query))
        elif parsed.path == "/api/detail":
            self.handle_detail(urllib.parse.parse_qs(parsed.query))
        elif parsed.path == "/api/posts":
            self.handle_posts(urllib.parse.parse_qs(parsed.query))
        elif parsed.path == "/api/search":
            self.handle_search(urllib.parse.parse_qs(parsed.query))
        else:
            self.send_error(404)

    def handle_search(self, qs: dict):
        query = qs.get("q", [""])[0].strip()
        if not query or len(query) > 40:
            self.send_json({"error": "검색어가 잘못됐습니다."}, status=400)
            return
        try:
            self.send_json(get_search(query))
        except Exception as exc:
            self.send_json({"error": f"검색 실패: {exc}"}, status=502)

    def handle_posts(self, qs: dict):
        ticker = qs.get("ticker", [""])[0].upper()
        if not TICKER_RE.fullmatch(ticker):
            self.send_json({"error": "잘못된 티커입니다."}, status=400)
            return
        try:
            self.send_json(get_posts(ticker))
        except Exception as exc:
            self.send_json({"error": f"게시물·뉴스 수집 실패: {exc}"}, status=502)

    def handle_detail(self, qs: dict):
        ticker = qs.get("ticker", [""])[0].upper()
        rng = qs.get("range", ["1d"])[0]
        if not TICKER_RE.fullmatch(ticker):
            self.send_json({"error": "잘못된 티커입니다."}, status=400)
            return
        if rng not in pm.RANGE_INTERVAL:
            self.send_json({"error": "잘못된 차트 범위입니다."}, status=400)
            return
        try:
            self.send_json(get_detail(ticker, rng))
        except Exception as exc:
            self.send_json({"error": f"차트 데이터 수집 실패: {exc}"}, status=502)

    def handle_api(self, qs: dict):
        filter_name = qs.get("filter", ["all-stocks"])[0]
        if not filter_name.replace("-", "").isalnum():
            self.send_json({"error": "잘못된 필터 이름입니다."}, status=400)
            return
        try:
            max_price = float(qs.get("max_price", ["5"])[0])
            min_mentions = int(qs.get("min_mentions", ["2"])[0])
        except ValueError:
            self.send_json({"error": "숫자 파라미터가 잘못됐습니다."}, status=400)
            return
        try:
            self.send_json(get_payload(filter_name, max_price, min_mentions))
        except Exception as exc:  # 외부 API 장애를 클라이언트에 그대로 전달
            self.send_json({"error": f"데이터 수집 실패: {exc}"}, status=502)

    def send_json(self, obj: dict, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, name: str, content_type: str):
        path = BASE_DIR / name
        if not path.exists():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{datetime.now():%H:%M:%S}] {fmt % args}\n")


def main():
    # 클라우드 호스팅(Render 등)은 PORT 환경변수로 포트를 지정하고 0.0.0.0 바인딩이 필요함
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"레딧 페니주식 대시보드: http://localhost:{port}  (Ctrl+C로 종료)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
