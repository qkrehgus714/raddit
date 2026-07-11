"""레딧 페니주식 스크리너.

ApeWisdom API로 레딧 주식 서브레딧들의 티커 언급 순위를 가져오고,
Yahoo Finance로 주가를 붙여 실제 페니주식(기본 $5 미만)만 걸러낸다.

사용법:
    python penny_mentions.py                # all-stocks 집계 + $5 미만 필터
    python penny_mentions.py pennystocks    # r/pennystocks만, 가격 필터 없이
    python penny_mentions.py wallstreetbets
"""
import json
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")

APEWISDOM_URL = "https://apewisdom.io/api/v1.0/filter/{filter}/page/{page}"
YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"

# 사용 가능한 필터: all, all-stocks, all-crypto, wallstreetbets, stocks,
# investing, pennystocks, options, daytrading, shortsqueeze 등
DEFAULT_FILTER = "all-stocks"
PENNY_MAX_PRICE = 5.0   # 페니주식 기준 가격 (USD)
MIN_MENTIONS = 2        # 이 미만 언급은 노이즈로 간주
PRICE_LOOKUP_LIMIT = 120  # 주가를 조회할 상위 티커 수
TOP_N = 30


def http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def fetch_mentions(filter_name: str) -> list[dict]:
    first = http_get_json(APEWISDOM_URL.format(filter=filter_name, page=1))
    results = first["results"]
    for page in range(2, first["pages"] + 1):
        results += http_get_json(APEWISDOM_URL.format(filter=filter_name, page=page))["results"]
    results.sort(key=lambda x: x["mentions"], reverse=True)
    return results


def fetch_quote(ticker: str) -> dict | None:
    try:
        meta = http_get_json(YAHOO_URL.format(ticker=ticker))["chart"]["result"][0]["meta"]
        price = meta.get("regularMarketPrice")
        prev = meta.get("previousClose") or meta.get("chartPreviousClose")
        if price is None:
            return None
        return {
            "price": price,
            "day_change_pct": (price - prev) / prev * 100 if prev else None,
            "volume": meta.get("regularMarketVolume"),
        }
    except Exception:
        return None


def attach_quotes(items: list[dict]) -> None:
    with ThreadPoolExecutor(max_workers=10) as pool:
        quotes = pool.map(lambda it: fetch_quote(it["ticker"]), items)
    for item, quote in zip(items, quotes):
        item["quote"] = quote


# ── 티커 관련 레딧 게시물·뉴스 ──
# 레딧 JSON API는 비로그인 요청을 403으로 차단하지만 RSS 검색 피드는 열려 있다.
REDDIT_SEARCH_SUBS = "pennystocks+wallstreetbets+stocks+investing+Shortsqueeze+smallstreetbets"
REDDIT_RSS_URL = ("https://www.reddit.com/r/{subs}/search.rss"
                  "?q={q}&restrict_sr=on&sort=new&t=month&limit={limit}")
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
NEWS_SEARCH_URL = ("https://query1.finance.yahoo.com/v1/finance/search"
                   "?q={q}&quotesCount=0&newsCount=8")


def fetch_reddit_posts(ticker: str, limit: int = 15) -> list[dict]:
    """주식 서브레딧들에서 티커를 검색한 최근 1개월 게시물 (Atom 피드 파싱)."""
    url = REDDIT_RSS_URL.format(subs=REDDIT_SEARCH_SUBS,
                                q=urllib.parse.quote(f'"{ticker}"'), limit=limit)
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read()
    ns = {"a": "http://www.w3.org/2005/Atom"}
    posts = []
    for entry in ET.fromstring(body).findall("a:entry", ns):
        link = entry.find("a:link", ns)
        cat = entry.find("a:category", ns)
        try:
            ts = int(datetime.fromisoformat(entry.findtext("a:updated", "", ns)).timestamp())
        except ValueError:
            ts = None
        posts.append({
            "title": entry.findtext("a:title", "", ns),
            "url": link.get("href") if link is not None else None,
            "subreddit": cat.get("label") if cat is not None else None,
            "ts": ts,
        })
    posts.sort(key=lambda p: p["ts"] or 0, reverse=True)
    return posts


def fetch_news(ticker: str) -> list[dict]:
    """Yahoo Finance 검색 API의 티커 관련 뉴스."""
    data = http_get_json(NEWS_SEARCH_URL.format(q=urllib.parse.quote(ticker)))
    return [{
        "title": n.get("title"),
        "publisher": n.get("publisher"),
        "url": n.get("link"),
        "ts": n.get("providerPublishTime"),
    } for n in data.get("news", [])]


SYMBOL_SEARCH_URL = ("https://query1.finance.yahoo.com/v1/finance/search"
                     "?q={q}&quotesCount=8&newsCount=0")


def search_symbols(query: str) -> list[dict]:
    """티커·회사명으로 심볼 검색 (Yahoo Finance 자동완성)."""
    data = http_get_json(SYMBOL_SEARCH_URL.format(q=urllib.parse.quote(query)))
    return [{
        "ticker": q["symbol"],
        "name": q.get("shortname") or q.get("longname"),
        "exchange": q.get("exchDisp"),
    } for q in data.get("quotes", [])
        if q.get("symbol") and q.get("quoteType") in ("EQUITY", "ETF")]


# 차트 범위별 봉 간격 (Yahoo Finance chart API 파라미터)
# 캔들이 읽히려면 화면에 봉이 너무 많으면 안 됨 — 1일은 15분봉(~64개), 5일은 1시간봉(~33개)
RANGE_INTERVAL = {"1d": "15m", "5d": "60m", "1mo": "1d", "6mo": "1d", "1y": "1d"}


def fetch_chart(ticker: str, rng: str) -> dict:
    """지정 범위의 시세 시계열. 반환: {"meta": ..., "points": [{t, o, h, l, c, v}, ...]}

    1일 차트는 프리·애프터마켓 포함 (페니주식은 장외 급등락이 잦음).
    시가·고가·저가가 비어 있는 봉은 종가로 채워 캔들 표시가 끊기지 않게 한다.
    """
    prepost = "true" if rng == "1d" else "false"
    url = (YAHOO_URL.format(ticker=urllib.parse.quote(ticker))
           + f"?range={rng}&interval={RANGE_INTERVAL[rng]}&includePrePost={prepost}")
    result = http_get_json(url)["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    ts = result.get("timestamp") or []
    closes = quote.get("close") or []
    opens = quote.get("open") or [None] * len(closes)
    highs = quote.get("high") or [None] * len(closes)
    lows = quote.get("low") or [None] * len(closes)
    vols = quote.get("volume") or [None] * len(closes)
    points = [
        {"t": t,
         "o": round(o if o is not None else c, 4),
         "h": round(h if h is not None else c, 4),
         "l": round(l if l is not None else c, 4),
         "c": round(c, 4), "v": v}
        for t, o, h, l, c, v in zip(ts, opens, highs, lows, closes, vols)
        if c is not None
    ]
    return {"meta": result["meta"], "points": points}


def _sma(values: list, n: int) -> float | None:
    return sum(values[-n:]) / n if len(values) >= n else None


def _rsi(closes: list, n: int = 14) -> float | None:
    if len(closes) < n + 1:
        return None
    gains = losses = 0.0
    for prev, cur in zip(closes[-n - 1:-1], closes[-n:]):
        diff = cur - prev
        if diff >= 0:
            gains += diff
        else:
            losses -= diff
    if losses == 0:
        return 100.0
    return 100 - 100 / (1 + gains / losses)


def _ema_series(values: list, n: int) -> list | None:
    """n일 지수이동평균 시계열 — values[n-1:] 구간에 정렬돼 반환."""
    if len(values) < n:
        return None
    k = 2 / (n + 1)
    ema = sum(values[:n]) / n
    out = [ema]
    for v in values[n:]:
        ema = v * k + (1 - k) * ema
        out.append(ema)
    return out


def _macd(closes: list) -> dict | None:
    """MACD(12·26·9) — 마지막 히스토그램 값과 가장 최근 시그널선 교차."""
    e12, e26 = _ema_series(closes, 12), _ema_series(closes, 26)
    if not e12 or not e26:
        return None
    line = [a - b for a, b in zip(e12[-len(e26):], e26)]
    sig = _ema_series(line, 9)
    if not sig:
        return None
    hist = [m - s for m, s in zip(line[-len(sig):], sig)]
    cross = None
    for i in range(len(hist) - 1, 0, -1):
        if (hist[i] >= 0) != (hist[i - 1] >= 0):
            cross = {"days_ago": len(hist) - 1 - i, "golden": hist[i] >= 0}
            break
    return {"hist": hist[-1], "cross": cross}


def _bollinger(closes: list, n: int = 20, k: float = 2.0) -> dict | None:
    """볼린저밴드(20일, 2σ) — %B, 밴드 폭(%), 스퀴즈(폭이 최근 하위 20%) 여부."""
    if len(closes) < n:
        return None
    widths = []
    for i in range(n, len(closes) + 1):
        win = closes[i - n:i]
        mid = sum(win) / n
        sd = (sum((c - mid) ** 2 for c in win) / n) ** 0.5
        if mid:
            widths.append(2 * k * sd / mid * 100)
    win = closes[-n:]
    mid = sum(win) / n
    sd = (sum((c - mid) ** 2 for c in win) / n) ** 0.5
    upper, lower = mid + k * sd, mid - k * sd
    pctb = (closes[-1] - lower) / (upper - lower) * 100 if upper > lower else None
    width = widths[-1] if widths else None
    recent = widths[-120:]
    squeeze = (width is not None and len(recent) >= 60
               and width <= sorted(recent)[max(0, len(recent) // 5 - 1)])
    return {"pctb": pctb, "width": width, "squeeze": squeeze}


def compute_overlays(daily_points: list[dict], k: float = 2.0) -> list[dict]:
    """일봉 차트에 겹칠 20·50일 이동평균 + 볼린저밴드 시계열.

    반환: [{t, s20, s50, bu, bl}, ...] — 이력이 부족한 앞부분은 None.
    """
    closes = [p["c"] for p in daily_points]
    out = []
    for i, p in enumerate(daily_points):
        row = {"t": p["t"], "s20": None, "s50": None, "bu": None, "bl": None}
        if i + 1 >= 20:
            win = closes[i - 19:i + 1]
            mid = sum(win) / 20
            sd = (sum((c - mid) ** 2 for c in win) / 20) ** 0.5
            row["s20"] = round(mid, 4)
            row["bu"] = round(mid + k * sd, 4)
            row["bl"] = round(mid - k * sd, 4)
        if i + 1 >= 50:
            row["s50"] = round(sum(closes[i - 49:i + 1]) / 50, 4)
        out.append(row)
    return out


def analyze(daily_points: list[dict], meta: dict) -> dict:
    """1년치 일봉으로 기술 지표를 계산하고 한국어 시그널로 요약한다."""
    closes = [p["c"] for p in daily_points]
    volumes = [p["v"] for p in daily_points if p.get("v")]
    if len(closes) < 5:
        return {"summary": "시세 데이터가 부족해 분석할 수 없습니다.",
                "signals": [], "indicators": {}}

    price = meta.get("regularMarketPrice") or closes[-1]
    sma20, sma50 = _sma(closes, 20), _sma(closes, 50)
    rsi14 = _rsi(closes)
    hi52, lo52 = max(closes), min(closes)
    pos52 = (price - lo52) / (hi52 - lo52) * 100 if hi52 > lo52 else None
    vol_now = meta.get("regularMarketVolume") or (volumes[-1] if volumes else None)
    avg_vol = _sma(volumes, min(20, len(volumes))) if volumes else None
    vol_ratio = vol_now / avg_vol if vol_now and avg_vol else None
    recent = closes[-21:]
    moves = [abs(b / a - 1) * 100 for a, b in zip(recent, recent[1:]) if a]
    volatility = sum(moves) / len(moves) if moves else None
    macd = _macd(closes)
    bb = _bollinger(closes)

    signals, score = [], 0
    if sma20 and sma50:
        if price > sma20 > sma50:
            signals.append({"tone": "up", "label": "추세",
                            "text": "20·50일 이동평균선 위 — 단·중기 상승 추세"})
            score += 1
        elif price < sma20 < sma50:
            signals.append({"tone": "down", "label": "추세",
                            "text": "20·50일 이동평균선 아래 — 단·중기 하락 추세"})
            score -= 1
        else:
            signals.append({"tone": "flat", "label": "추세",
                            "text": "이동평균선이 엇갈려 방향성이 뚜렷하지 않음"})
    if rsi14 is not None:
        if rsi14 >= 70:
            signals.append({"tone": "down", "label": "RSI",
                            "text": f"RSI {rsi14:.0f} — 과매수 구간, 단기 조정 유의"})
            score -= 1
        elif rsi14 <= 30:
            signals.append({"tone": "up", "label": "RSI",
                            "text": f"RSI {rsi14:.0f} — 과매도 구간, 기술적 반등 여지"})
            score += 1
        else:
            signals.append({"tone": "flat", "label": "RSI",
                            "text": f"RSI {rsi14:.0f} — 중립 구간"})
    macd_text = None
    if macd:
        cross = macd["cross"]
        if cross and cross["days_ago"] <= 30:
            when = "오늘" if cross["days_ago"] == 0 else f"{cross['days_ago']}일 전"
            macd_text = ("골든" if cross["golden"] else "데드") + f"크로스 {when}"
        else:
            macd_text = "상승 모멘텀" if macd["hist"] > 0 else "하락 모멘텀"
        if cross and cross["days_ago"] <= 5:
            when = "오늘" if cross["days_ago"] == 0 else f"{cross['days_ago']}일 전"
            if cross["golden"]:
                signals.append({"tone": "up", "label": "MACD",
                                "text": f"골든크로스 {when} 발생 — 모멘텀 상승 전환"})
                score += 1
            else:
                signals.append({"tone": "down", "label": "MACD",
                                "text": f"데드크로스 {when} 발생 — 모멘텀 하락 전환"})
                score -= 1
        elif macd["hist"] > 0:
            signals.append({"tone": "up", "label": "MACD",
                            "text": "MACD가 시그널선 위 — 상승 모멘텀 유지 중"})
        else:
            signals.append({"tone": "down", "label": "MACD",
                            "text": "MACD가 시그널선 아래 — 하락 모멘텀 지속"})
    if bb and bb["pctb"] is not None:
        if bb["pctb"] > 100:
            signals.append({"tone": "down", "label": "볼린저",
                            "text": f"상단 밴드 이탈 (%B {bb['pctb']:.0f}) — 단기 과열"})
            score -= 1
        elif bb["pctb"] < 0:
            signals.append({"tone": "up", "label": "볼린저",
                            "text": f"하단 밴드 이탈 (%B {bb['pctb']:.0f}) — 과매도, 반등 여지"})
            score += 1
        if bb["squeeze"]:
            signals.append({"tone": "flat", "label": "볼린저",
                            "text": "밴드 폭이 최근 6개월 최저 수준으로 수축 — 큰 변동 임박 가능"})
    if pos52 is not None:
        if pos52 >= 80:
            signals.append({"tone": "up", "label": "52주",
                            "text": f"52주 범위 상단 {pos52:.0f}% 지점 — 고점 부근"})
        elif pos52 <= 20:
            signals.append({"tone": "down", "label": "52주",
                            "text": f"52주 범위 하단 {pos52:.0f}% 지점 — 저점 부근"})
        else:
            signals.append({"tone": "flat", "label": "52주",
                            "text": f"52주 범위의 {pos52:.0f}% 지점"})
    if vol_ratio is not None:
        if vol_ratio >= 3:
            signals.append({"tone": "up", "label": "거래량",
                            "text": f"20일 평균의 {vol_ratio:.1f}배 — 거래 폭증, 관심 급등"})
            score += 1
        elif vol_ratio >= 1.5:
            signals.append({"tone": "up", "label": "거래량",
                            "text": f"20일 평균의 {vol_ratio:.1f}배 — 평소보다 활발"})
        elif vol_ratio < 0.7:
            signals.append({"tone": "flat", "label": "거래량",
                            "text": f"20일 평균의 {vol_ratio:.1f}배 — 한산한 편"})
        else:
            signals.append({"tone": "flat", "label": "거래량",
                            "text": f"20일 평균의 {vol_ratio:.1f}배 — 보통 수준"})
    if len(closes) >= 6 and closes[-6] and len(volumes) >= 20:
        chg5 = (closes[-1] / closes[-6] - 1) * 100
        vol20_avg = _sma(volumes, 20)
        vr5 = _sma(volumes, 5) / vol20_avg if vol20_avg else None
        if vr5 is not None:
            if chg5 >= 10 and vr5 < 0.8:
                signals.append({"tone": "down", "label": "수급",
                                "text": f"5일간 {chg5:+.0f}% 올랐지만 거래량은 감소 — 거래량 없는 상승, 펌핑 유의"})
                score -= 1
            elif chg5 >= 10 and vr5 >= 1.3:
                signals.append({"tone": "up", "label": "수급",
                                "text": f"5일간 {chg5:+.0f}% 상승에 거래량 증가 동반 — 수급이 뒷받침됨"})
                score += 1
            elif chg5 <= -10 and vr5 >= 1.3:
                signals.append({"tone": "down", "label": "수급",
                                "text": f"5일간 {chg5:+.0f}% 하락에 거래량 증가 — 매도 압력이 큼"})
                score -= 1
    if volatility is not None and volatility >= 6:
        signals.append({"tone": "down", "label": "변동성",
                        "text": f"최근 20일 일평균 ±{volatility:.1f}% — 변동성이 매우 큼"})

    if score >= 2:
        summary = "단기 기술 지표가 대체로 긍정적입니다."
    elif score <= -2:
        summary = "단기 기술 지표가 대체로 부정적입니다."
    elif score > 0:
        summary = "기술 지표가 약간 긍정적이나 확신하기는 이릅니다."
    elif score < 0:
        summary = "기술 지표가 약간 부정적입니다."
    else:
        summary = "기술 지표가 혼조세로, 뚜렷한 방향성이 없습니다."

    return {
        "summary": summary,
        "signals": signals,
        "indicators": {
            "price": price, "sma20": sma20, "sma50": sma50, "rsi14": rsi14,
            "high52": hi52, "low52": lo52, "pos52": pos52,
            "vol_ratio": vol_ratio, "volatility20": volatility,
            "macd_text": macd_text,
            "macd_hist": macd["hist"] if macd else None,
            "bb_pctb": bb["pctb"] if bb else None,
            "bb_width": bb["width"] if bb else None,
        },
    }


def rank_change(item: dict) -> str:
    prev = item.get("rank_24h_ago")
    if not prev:
        return "NEW"
    diff = prev - item["rank"]
    if diff > 0:
        return f"▲{diff}"
    if diff < 0:
        return f"▼{-diff}"
    return "-"


def print_table(items: list[dict], title: str) -> None:
    print(f"\n  {title}\n")
    print(f"  {'순위':>4} {'티커':<7} {'종목명':<24} {'언급':>5} {'업보트':>6} "
          f"{'24h순위':>7} {'현재가':>8} {'등락':>8}")
    print("  " + "-" * 78)
    for i, item in enumerate(items, 1):
        name = (item.get("name") or "")[:22]
        quote = item.get("quote")
        if quote:
            price = f"${quote['price']:.2f}"
            pct = quote["day_change_pct"]
            change = f"{pct:+.1f}%" if pct is not None else "-"
        else:
            price, change = "-", "-"
        print(f"  {i:>4} {item['ticker']:<7} {name:<24} {item['mentions']:>5} "
              f"{item['upvotes']:>6} {rank_change(item):>7} {price:>8} {change:>8}")
    print()


def main() -> None:
    filter_name = sys.argv[1] if len(sys.argv) > 1 else None

    if filter_name:
        # 특정 서브레딧 순위를 가격 필터 없이 그대로 출력
        items = [it for it in fetch_mentions(filter_name) if it["mentions"] >= MIN_MENTIONS]
        items = items[:TOP_N]
        attach_quotes(items)
        print_table(items, f"r/{filter_name} 언급 순위 TOP {len(items)}")
        return

    # 기본 모드: 전체 주식 서브레딧 집계에서 페니주식만 스크리닝
    print(f"\n  ApeWisdom {DEFAULT_FILTER} 집계 조회 중...")
    items = [it for it in fetch_mentions(DEFAULT_FILTER) if it["mentions"] >= MIN_MENTIONS]
    candidates = items[:PRICE_LOOKUP_LIMIT]
    print(f"  {len(candidates)}개 티커 주가 조회 중 (Yahoo Finance)...")
    attach_quotes(candidates)

    pennies = [it for it in candidates
               if it.get("quote") and it["quote"]["price"] < PENNY_MAX_PRICE]
    print_table(pennies[:TOP_N],
                f"레딧 언급 상위 페니주식 (<${PENNY_MAX_PRICE:.0f}, "
                f"전체 주식 서브레딧 기준)")


if __name__ == "__main__":
    main()
