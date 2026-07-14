// raddit 메인 대시보드 — SolidJS 컴포넌트
// dashboard.html 1,126줄을 컴포넌트화. 모든 기능 100% 동등.
import { createSignal, onMount, onCleanup, createMemo, Show, For } from "solid-js";
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle, createSeriesMarkers } from "lightweight-charts";
import type { IChartApi, ISeriesApi, IPriceLine, UTCTimestamp, MouseEventParams, TickMarkFormatter, ISeriesMarkersPluginApi, SeriesMarker } from "lightweight-charts";
import { computeDivergences } from "../lib/indicators";
import { SessionBandsPrimitive, computeIntradaySessions } from "../lib/sessionBands";

// ── 상수 ──
const FALSE_POSITIVE = new Set(["EU","IQ","RR","LINK","DC","API","LOT","ALL","PR","MA","D","ES","GL","IP","CAT","MU","ON","SO","IT","GO","AN","BE"]);
const FILTER_NAMES: Record<string, string> = {
  "all-stocks": "전체 주식 서브레딧", "wallstreetbets": "r/wallstreetbets",
  "pennystocks": "r/pennystocks", "stocks": "r/stocks",
  "investing": "r/investing", "shortsqueeze": "r/Shortsqueeze",
};
const RANGES: [string, string][] = [["min","5분"],["day","일"],["week","주"],["month","월"],["year","년"]];
const CANDLE_LABEL: Record<string, string> = { min:"5분봉", day:"일봉", week:"주봉", month:"월봉", year:"연봉" };

const COLS = [
  { key: "rank",     label: "전체순위", left: false },
  { key: "ticker",   label: "티커 / 종목명", left: true },
  { key: "price",    label: "현재가", left: false },
  { key: "chg",      label: "등락", left: false },
  { key: "bidask",   label: "호가 (매수%)", left: false },
  { key: "mentions", label: "언급 (24h)", left: false },
  { key: "upvotes",  label: "업보트", left: false },
  { key: "move",     label: "순위변동", left: false },
  { key: "vol",      label: "거래량", left: false },
];

// ── 유틸 ──
type Row = any;
function fmtVol(v: number | null): string {
  if (v == null) return "-";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}
function fmtPrice(v: number): string { return "$" + (Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2)); }
function fmtM(v: number | null | undefined): string {
  if (v == null) return "-";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e12) return sign + "$" + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "K";
  return sign + "$" + a.toFixed(0);
}
function rankMove(d: Row): { cls: string; txt: string } {
  if (!d.rank_24h_ago) return { cls: "new", txt: "NEW" };
  const diff = d.rank_24h_ago - d.rank;
  if (diff > 0) return { cls: "up", txt: "▲" + diff };
  if (diff < 0) return { cls: "down", txt: "▼" + (-diff) };
  return { cls: "flat", txt: "—" };
}
function timeAgo(ts: number | null): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "분 전";
  if (s < 86400) return Math.round(s / 3600) + "시간 전";
  return Math.round(s / 86400) + "일 전";
}
function sortVal(r: Row, key: string): number | string {
  if (key === "move") return r.rank_24h_ago ? r.rank_24h_ago - r.rank : Infinity;
  if (key === "bidask") return r.bidAskPct == null ? -Infinity : r.bidAskPct;
  if (key === "ticker") return r.ticker;
  const v = r[key];
  return v == null ? -Infinity : v;
}

export default function Dashboard() {
  // ── 시그널 ──
  const [rows, setRows] = createSignal<Row[]>([]);
  const [sortKey, setSortKey] = createSignal("mentions");
  const [sortDir, setSortDir] = createSignal(-1);
  const [filterVal, setFilterVal] = createSignal("all-stocks");
  const [priceVal, setPriceVal] = createSignal("5");
  const [loading, setLoading] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [statusError, setStatusError] = createSignal(false);
  const [snapshot, setSnapshot] = createSignal("불러오는 중…");
  const [scanned, setScanned] = createSignal(0);
  const [boardTitle, setBoardTitle] = createSignal("언급 상위 종목");
  const [version, setVersion] = createSignal("v0.1.0");
  const [starCount, setStarCount] = createSignal<number | null>(null);

  // 상세 모달
  const [dlgOpen, setDlgOpen] = createSignal(false);
  const [dlgTicker, setDlgTicker] = createSignal("");
  const [dlgName, setDlgName] = createSignal("");
  const [dlgPrice, setDlgPrice] = createSignal("");
  const [dlgChgHtml, setDlgChgHtml] = createSignal("");
  const [dlgRedditInfo, setDlgRedditInfo] = createSignal("");
  const [dlgRange, setDlgRange] = createSignal("min");
  const [dlgStatus, setDlgStatus] = createSignal("");
  const [dlgSummary, setDlgSummary] = createSignal("");
  const [dlgIndicators, setDlgIndicators] = createSignal<[string, string][]>([]);
  const [dlgSignals, setDlgSignals] = createSignal<{tone:string;label:string;text:string}[]>([]);
  const [chartMeta, setChartMeta] = createSignal("");
  const [chartDim, setChartDim] = createSignal(false);
  const [chartMsg, setChartMsg] = createSignal("");
  const [showDiv, setShowDiv] = createSignal(true);
  const [bidAskPct, setBidAskPct] = createSignal<number | null>(null);

  // 게시물
  const [redditPosts, setRedditPosts] = createSignal<{title:string;url:string|null;subreddit:string|null;ts:number|null}[]>([]);
  const [redditEmpty, setRedditEmpty] = createSignal("");
  const [newsPosts, setNewsPosts] = createSignal<{title:string;publisher?:string;url?:string;ts?:number}[]>([]);
  const [newsEmpty, setNewsEmpty] = createSignal("");
  // SEC 펀더멘털(공시·재무)
  const [fund, setFund] = createSignal<{cik:string|null; filings:{form:string;date:string;docDesc:string|null;url:string}[]; financials:any|null} | null>(null);
  const [fundLoading, setFundLoading] = createSignal(false);
  const [fundError, setFundError] = createSignal("");
  const [stSent, setStSent] = createSignal<{bullish_pct:number|null; messages:{body:string;username:string;ts:number|null;sentiment:string|null}[]; total:number; tagged:number} | null>(null);
  const [stEmpty, setStEmpty] = createSignal("");
  const [stEnabled, setStEnabled] = createSignal(false);

  // Changelog
  const [clOpen, setClOpen] = createSignal(false);
  const [clHtml, setClHtml] = createSignal('<div class="cl-loading">불러오는 중…</div>');

  // 검색
  const [searchInput, setSearchInput] = createSignal("");
  const [searchDrop, setSearchDrop] = createSignal(false);
  const [searchItems, setSearchItems] = createSignal<{ticker:string;name:string|null;exchange:string|null}[]>([]);
  const [searchEmpty, setSearchEmpty] = createSignal("");

  // refs
  let chartWrapRef: HTMLDivElement | undefined;
  let chartContainerRef: HTMLDivElement | undefined;
  let chart: IChartApi | null = null;
  let candleSeries: ISeriesApi<"Candlestick"> | null = null;
  let sessionBands: SessionBandsPrimitive | null = null;
  let divMarkers: ISeriesMarkersPluginApi<any> | null = null;
  let volSeries: ISeriesApi<"Histogram"> | null = null;
  let ma20Series: ISeriesApi<"Line"> | null = null;
  let ma50Series: ISeriesApi<"Line"> | null = null;
  let bbUpSeries: ISeriesApi<"Line"> | null = null;
  let bbLowSeries: ISeriesApi<"Line"> | null = null;
  let dlgSeq = 0;
  let dlgTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;

  const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ── 데이터 로드 ──
  async function load() {
    setLoading(true);
    setStatus("수집 중… (주가 조회에 수십 초 걸릴 수 있음)");
    setStatusError(false);
    try {
      const res = await fetch(`/api/data?filter=${encodeURIComponent(filterVal())}&max_price=${priceVal()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      const filtered = data.items.filter((d: Row) =>
        // FALSE_POSITIVE(일반 단어·약어 충돌)는 제외하되, 실제 $5 미만 주식으로 확인된 티커는 보존
        !FALSE_POSITIVE.has(d.ticker) || (d.quote && d.quote.price != null && d.quote.price < (Number(priceVal()) || 5))
      ).map((d: Row) => ({
        ...d,
        price: d.quote ? d.quote.price : null,
        chg: d.quote ? d.quote.day_change_pct : null,
        vol: d.quote ? d.quote.volume : null,
        bidAskPct: d.buy_ratio_pct ?? null,
        bidAskTotal: d.bidAskTotal ?? null,
      }));
      setRows(filtered);
      setScanned(data.scanned);
      setSnapshot(`${data.generated_at} 기준`);
      setBoardTitle(
        `${FILTER_NAMES[filterVal()] || filterVal()} 언급 상위` +
        (Number(priceVal()) > 0 ? ` 페니주식 (<$${priceVal()})` : " 종목") + ` · ${filtered.length}개`
      );
      setStatus("");
    } catch (err: any) {
      setStatus("불러오기 실패: " + err.message);
      setStatusError(true);
    } finally {
      setLoading(false);
    }
  }

  // ── 정렬 ──
  function toggleSort(key: string) {
    if (sortKey() === key) setSortDir(-sortDir());
    else { setSortKey(key); setSortDir(-1); }
  }

  const sortedRows = createMemo(() => {
    const r = rows();
    if (!r.length) return [];
    return [...r].sort((a, b) => {
      const va = sortVal(a, sortKey()), vb = sortVal(b, sortKey());
      return ((va < vb ? -1 : va > vb ? 1 : 0) as number) * sortDir();
    });
  });

  const maxMentions = createMemo(() => {
    const r = rows();
    return r.length ? Math.max(...r.map(x => x.mentions)) : 1;
  });

  const tiles = createMemo(() => {
    const r = rows();
    const priced = r.filter((x: Row) => x.chg != null);
    const topMover = priced.length ? priced.reduce((a: Row, b: Row) => (b.chg > a.chg ? b : a)) : null;
    const topClean = r.length ? r.reduce((a: Row, b: Row) => (b.mentions > a.mentions ? b : a)) : null;
    return { scanned: scanned(), rowsLen: r.length, maxPrice: Number(priceVal()), topMover, topClean };
  });

  // ── 차트 (lightweight-charts) ──
  const KST_TZ = "Asia/Seoul";
  let currentTipFmt: Intl.DateTimeFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: KST_TZ });
  let baselineLine: IPriceLine | null = null;
  let mqListener: ((e: MediaQueryListEvent) => void) | null = null;
  let lastChartData: any = null;
  let lastRange: string | null = null;

  function applyTheme() {
    if (!chart) return;
    const ink3 = cssVar("--ink-3"), line = cssVar("--line"), card = cssVar("--card");
    chart.applyOptions({
      layout: { textColor: ink3, background: { type: ColorType.Solid, color: card } },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line },
      crosshair: { vertLine: { color: ink3, labelBackgroundColor: card }, horzLine: { color: ink3, labelBackgroundColor: card } },
    });
    const up = cssVar("--up"), down = cssVar("--down");
    candleSeries?.applyOptions({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    volSeries?.applyOptions({ color: cssVar("--bar") });
    ma20Series?.applyOptions({ color: cssVar("--accent") });
    ma50Series?.applyOptions({ color: cssVar("--ma-slow") });
    bbUpSeries?.applyOptions({ color: ink3 });
    bbLowSeries?.applyOptions({ color: ink3 });
  }

  function ensureChart() {
    if (chart || !chartContainerRef) return;
    const ink3 = cssVar("--ink-3"), line = cssVar("--line"), card = cssVar("--card");
    chart = createChart(chartContainerRef, {
      autoSize: true,
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: card }, textColor: ink3 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: ink3, labelBackgroundColor: card },
        horzLine: { color: ink3, labelBackgroundColor: card },
      },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      localization: {
        priceFormatter: (p: number) => fmtPrice(p),
        timeFormatter: (t: number) => currentTipFmt.format(new Date(t * 1000)),
      },
    });
    const up = cssVar("--up"), down = cssVar("--down");
    candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
    });
    sessionBands = new SessionBandsPrimitive(cssVar("--session-tint"));
    candleSeries.attachPrimitive(sessionBands);
    divMarkers = createSeriesMarkers(candleSeries, []);
    volSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "", color: cssVar("--bar") });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // 오버레이(MA/BB)는 가격 스케일 자동범위 산정에서 제외 — 캔들 데이터만으로 Y축을 정해
    // 넓은 BB 밴드가 캔들을 찌그러뜨리는 것을 방지 (구 Canvas 차트와 동일 동작: 오버레이는 clip)
    const lineOpts: any = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null };
    ma20Series = chart.addSeries(LineSeries, { color: cssVar("--accent"), lineWidth: 2, ...lineOpts });
    ma50Series = chart.addSeries(LineSeries, { color: cssVar("--ma-slow"), lineWidth: 2, lineStyle: LineStyle.Dotted, ...lineOpts });
    bbUpSeries = chart.addSeries(LineSeries, { color: ink3, lineWidth: 1, ...lineOpts });
    bbLowSeries = chart.addSeries(LineSeries, { color: ink3, lineWidth: 1, ...lineOpts });
    chart.subscribeCrosshairMove(onCrosshair);
  }

  function destroyChart() {
    if (chart) { chart.remove(); chart = null; }
    candleSeries = volSeries = ma20Series = ma50Series = bbUpSeries = bbLowSeries = null;
    divMarkers = null;
    baselineLine = null;
    sessionBands = null;
  }

  function clearChart(msg?: string) {
    hideTip();
    lastRange = null;
    lastChartData = null;
    candleSeries?.setData([]);
    divMarkers?.setMarkers([]);
    volSeries?.setData([]);
    ma20Series?.setData([]);
    ma50Series?.setData([]);
    bbUpSeries?.setData([]);
    bbLowSeries?.setData([]);
    if (baselineLine && candleSeries) { candleSeries.removePriceLine(baselineLine); baselineLine = null; }
    setChartMsg(msg || "");
    setChartMeta("");
  }

  function hideTip() {
    const tip = document.getElementById("chart-tip");
    if (tip) tip.hidden = true;
  }

  function onCrosshair(param: MouseEventParams) {
    const tip = document.getElementById("chart-tip");
    const wrap = chartWrapRef;
    if (!tip || !wrap || !param.time || !param.point || !candleSeries) { hideTip(); return; }
    const d = param.seriesData.get(candleSeries) as { open?: number; high?: number; low?: number; close: number } | undefined;
    if (!d) { hideTip(); return; }
    const o = d.open ?? d.close;
    tip.hidden = false;
    tip.innerHTML = "";
    const strong = document.createElement("strong"); strong.textContent = fmtPrice(d.close);
    const ohlc = document.createElement("span");
    ohlc.textContent = `시 ${fmtPrice(o)} · 고 ${fmtPrice(d.high ?? d.close)} · 저 ${fmtPrice(d.low ?? d.close)}`;
    const vd = volSeries ? param.seriesData.get(volSeries) as { value?: number } | undefined : undefined;
    const sub = document.createElement("span");
    sub.textContent = currentTipFmt.format(new Date((param.time as number) * 1000)) + (vd?.value ? " · 거래량 " + fmtVol(vd.value) : "");
    tip.append(strong, ohlc, sub);
    tip.style.left = Math.min(param.point.x + 12, wrap.clientWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = (param.point.y - 64 < 4 ? param.point.y + 14 : param.point.y - 64) + "px";
  }

  const axisTickFormatter = (range: string): TickMarkFormatter => (time, tickType) => {
    const d = new Date((time as number) * 1000);
    const opts: Intl.DateTimeFormatOptions = {};
    if (range === "min") {
      if (tickType <= 1) opts.month = "numeric";
      else if (tickType === 2) { opts.month = "numeric"; opts.day = "numeric"; }
      else { opts.hour = "2-digit"; opts.minute = "2-digit"; opts.hour12 = false; }
    } else {
      if (tickType === 0) opts.year = "numeric";
      else if (tickType === 1) { opts.year = "2-digit"; opts.month = "numeric"; }
      else { opts.month = "numeric"; opts.day = "numeric"; }
    }
    return new Intl.DateTimeFormat("ko-KR", { timeZone: KST_TZ, ...opts }).format(d);
  };

  function drawChart(data: any) {
    ensureChart();
    if (!chart || !candleSeries) return;
    // 레인지(봉 단위) 변경 시 가격 스케일 autoScale 재활성화 — 사용자가 수동으로
    // 가격축을 줌/드래그해 autoScale이 꺼진 상태라도 새 데이터에 맞춰 세로 리핏.
    // (동일 레인지 60초 자동갱신에선 사용자 줌을 존중해 건드리지 않음)
    if (data.range !== lastRange) { candleSeries.priceScale().applyOptions({ autoScale: true }); lastRange = data.range; }
    applyTheme();
    hideTip();
    setChartMsg("");

    const rawPts: any[] = data.points || [];
    if (rawPts.length < 2) { clearChart("표시할 시세 데이터가 없습니다"); return; }

    // lightweight-charts 요구: time 정렬 + 고유 — 중복/미정렬 정리
    const byT = new Map<number, any>();
    for (const p of rawPts) byT.set(p.t, p);
    const pts = [...byT.values()].sort((a, b) => a.t - b.t);

    const isMin = data.range === "min";
    chart.timeScale().applyOptions({ timeVisible: isMin, secondsVisible: false });
    chart.applyOptions({ timeScale: { tickMarkFormatter: axisTickFormatter(data.range) } });

    const TIP_OPT: Record<string, Intl.DateTimeFormatOptions> = {
      min: { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
      day: { year: "numeric", month: "numeric", day: "numeric" },
      week: { year: "numeric", month: "numeric", day: "numeric" },
      month: { year: "numeric", month: "numeric" },
      year: { year: "numeric", month: "numeric" },
    };
    currentTipFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: KST_TZ, ...(TIP_OPT[data.range] || TIP_OPT.day) });

    const minPrice = Math.min(...pts.map((p: any) => p.l != null ? p.l : p.c));
    candleSeries.applyOptions({ priceFormat: { type: "price", precision: minPrice < 1 ? 3 : 2, minMove: minPrice < 1 ? 0.001 : 0.01 } });

    candleSeries.setData(pts.map((p: any) => ({
      time: p.t as UTCTimestamp,
      open: p.o != null ? p.o : p.c,
      high: p.h != null ? p.h : Math.max(p.o != null ? p.o : p.c, p.c),
      low: p.l != null ? p.l : Math.min(p.o != null ? p.o : p.c, p.c),
      close: p.c,
    })));
    volSeries!.setData(pts.filter((p: any) => p.v).map((p: any) => ({ time: p.t as UTCTimestamp, value: p.v, color: cssVar("--bar") })));

    const toLine = (key: string) => {
      if (!data.overlays) return [];
      const m = new Map<number, any>();
      for (const o of data.overlays) if (o[key] != null) m.set(o.t, o);
      return [...m.values()].sort((a, b) => a.t - b.t).map((o: any) => ({ time: o.t as UTCTimestamp, value: o[key] }));
    };
    ma20Series!.setData(toLine("s20"));
    ma50Series!.setData(toLine("s50"));
    bbUpSeries!.setData(toLine("bu"));
    bbLowSeries!.setData(toLine("bl"));

    const baseline = isMin && data.prev_close ? data.prev_close : pts[0].c;
    if (baselineLine) { candleSeries.removePriceLine(baselineLine); baselineLine = null; }
    baselineLine = candleSeries.createPriceLine({
      price: baseline, color: cssVar("--ink-3"), lineStyle: LineStyle.Dashed, lineWidth: 1,
      axisLabelVisible: true, title: isMin && data.prev_close ? "전일종가" : "",
    });
    lastChartData = data;

    // 이슈 #48: 분봉(min) 일 때만 미국 프리/애프터마켓 세션 음영
    if (isMin && pts.length) {
      sessionBands?.setSessions(computeIntradaySessions(pts[0].t, pts[pts.length - 1].t));
    } else {
      sessionBands?.setSessions([]);
    }
    // 이슈 #57: RSI/MACD 다이버전스 마커
    const up = cssVar("--up"), down = cssVar("--down");
    const ptsForDiv = pts.map((p: any) => ({ t: p.t, o: p.o ?? p.c, h: p.h ?? p.c, l: p.l ?? p.c, c: p.c, v: p.v ?? null }));
    const divs = computeDivergences(ptsForDiv);
    const markers: SeriesMarker<any>[] = divs.map((d) => ({
      time: d.t as UTCTimestamp,
      position: d.type === "bull" ? "belowBar" : "aboveBar",
      shape: d.type === "bull" ? "arrowUp" : "arrowDown",
      color: d.type === "bull" ? up : down,   // 한국식: 강세=적, 약세=청
      text: (d.type === "bull" ? "강세" : "약세") + "다이버(" + d.oscillator + ")",
    }));
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    divMarkers?.setMarkers(showDiv() ? markers : []);

    chart.timeScale().fitContent();

    const highs = pts.map((p: any) => p.h != null ? p.h : p.c);
    const lows = pts.map((p: any) => p.l != null ? p.l : p.c);
    const rangeHi = Math.max(...highs), rangeLo = Math.min(...lows);
    const span = `${currentTipFmt.format(new Date(pts[0].t * 1000))} ~ ${currentTipFmt.format(new Date(pts[pts.length - 1].t * 1000))}`;
    setChartMeta(
      `${CANDLE_LABEL[data.range] || ""} ${span}` +
      ` · 고가 ${fmtPrice(rangeHi)} · 저가 ${fmtPrice(rangeLo)}` +
      (isMin && data.prev_close ? ` · 전일 종가 ${fmtPrice(data.prev_close)} (점선)` : " · 점선은 구간 시작가") +
      " · 한국시간 기준"
    );
  }

  // ── 상세 모달 ──
  function openDetail(ticker: string, fallbackName?: string) {
    const d = rows().find(r => r.ticker === ticker) || null;
    setDlgTicker(ticker); setDlgRange("min");
    setDlgName((d && d.name) || fallbackName || "");
    setDlgPrice(d && d.price != null ? fmtPrice(d.price) : "");
    setDlgChgHtml(d && d.chg != null
      ? `<span class="pill ${d.chg > 0 ? "up" : d.chg < 0 ? "down" : "flat"}">${(d.chg > 0 ? "+" : "") + d.chg.toFixed(2)}%</span>`
      : "");
    if (d) {
      const mv = rankMove(d);
      setDlgRedditInfo(`레딧 24시간: 언급 ${d.mentions}회 · 업보트 ${d.upvotes} · 순위변동 ${mv.txt}`);
    } else {
      setDlgRedditInfo("현재 레딧 언급 상위 목록에 없는 종목");
    }
    setDlgSummary(""); setDlgIndicators([]); setDlgSignals([]);
    setBidAskPct(null);
    setDlgOpen(true);
    document.body.classList.add("modal-open");
    clearChart();
    loadDetail();
    loadPosts(ticker);
    loadFundamentals(ticker);
  }

  function closeDetail() {
    setDlgTicker(""); dlgSeq++;
    clearTimeout(dlgTimer!); dlgTimer = null;
    lastChartData = null;
    hideTip();
    setDlgOpen(false);
    document.body.classList.remove("modal-open");
  }

  async function loadDetail() {
    const ticker = dlgTicker(), range = dlgRange(), seq = ++dlgSeq;
    clearTimeout(dlgTimer!);
    setDlgStatus("차트 불러오는 중…");
    setChartDim(true);
    try {
      const res = await fetch(`/api/detail?ticker=${encodeURIComponent(ticker)}&range=${range}`);
      const data = await res.json();
      if (seq !== dlgSeq) return;
      if (!res.ok) throw new Error(data.error || res.status);
      setDlgName(prev => prev || data.name || "");
      if (data.price != null) {
        setDlgPrice(fmtPrice(data.price));
        if (data.range === "min" && data.prev_close) {
          const chg = (data.price - data.prev_close) / data.prev_close * 100;
          setDlgChgHtml(`<span class="pill ${chg > 0 ? "up" : chg < 0 ? "down" : "flat"}">${(chg > 0 ? "+" : "") + chg.toFixed(2)}%</span>`);
        }
      }
      drawChart(data);
      renderAnalysis(data.analysis || {});
      setBidAskPct(data.buy_ratio_pct ?? null);
      setDlgStatus(`${data.generated_at} 갱신 · ${data.exchange || ""} ${data.currency || ""}` + (range === "min" ? " · 60초마다 자동 갱신" : ""));
      if (range === "min") dlgTimer = setTimeout(loadDetail, 60000);
    } catch (err: any) {
      if (seq !== dlgSeq) return;
      clearChart("시세 데이터를 찾을 수 없습니다");
      setDlgStatus("불러오기 실패: " + err.message);
    } finally {
      if (seq === dlgSeq) setChartDim(false);
    }
  }

  function renderAnalysis(a: any) {
    setDlgSummary(a.summary || "");
    const ind = a.indicators || {};
    setDlgIndicators([
      ["RSI (14일)", ind.rsi14 != null ? ind.rsi14.toFixed(0) : "-"],
      ["MACD (12·26·9)", ind.macd_text || "-"],
      ["볼린저 %B", ind.bb_pctb != null ? ind.bb_pctb.toFixed(0) + "%" : "-"],
      ["20일 이평선", ind.sma20 != null ? fmtPrice(ind.sma20) : "-"],
      ["50일 이평선", ind.sma50 != null ? fmtPrice(ind.sma50) : "-"],
      ["52주 최고 / 최저", ind.high52 != null ? `${fmtPrice(ind.high52)} / ${fmtPrice(ind.low52)}` : "-"],
      ["거래량 (20일 평균 대비)", ind.vol_ratio != null ? ind.vol_ratio.toFixed(1) + "배" : "-"],
      ["일평균 변동폭 (20일)", ind.volatility20 != null ? "±" + ind.volatility20.toFixed(1) + "%" : "-"],
    ]);
    setDlgSignals(a.signals || []);
  }

  // ── 게시물/뉴스 ──
  async function loadPosts(ticker: string) {
    setRedditPosts([]); setRedditEmpty("불러오는 중…");
    setNewsPosts([]); setNewsEmpty("불러오는 중…");
    setStSent(null); setStEmpty(""); setStEnabled(false);
    try {
      const res = await fetch(`/api/posts?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (dlgTicker() !== ticker) return;
      if (!res.ok) throw new Error(data.error || res.status);
      setRedditPosts(data.reddit || []);
      setRedditEmpty(data.reddit_error ? "레딧 불러오기 실패 (잠시 후 다시 시도해 주세요)" : "최근 1개월 내 관련 게시물이 없습니다");
      setNewsPosts(data.news || []);
      setNewsEmpty(data.news_error ? "뉴스 불러오기 실패" : "관련 뉴스가 없습니다");
      setStSent(data.stocktwits || null);
      setStEnabled(!!data.st_enabled);
      setStEmpty(data.st_error ? "StockTwits 불러오기 실패" : (data.stocktwits ? "" : "StockTwits 데이터 없음"));
    } catch (err: any) {
      if (dlgTicker() !== ticker) return;
      setRedditPosts([]); setRedditEmpty("불러오기 실패: " + err.message);
      setNewsPosts([]); setNewsEmpty("불러오기 실패: " + err.message);
      setStSent(null); setStEmpty("불러오기 실패: " + err.message);
    }
  }

  // ── SEC 펀더멘털(공시·재무) ── loadPosts 와 동일 패턴. EDGAR 장애는 독립.
  async function loadFundamentals(ticker: string) {
    setFund(null); setFundError(""); setFundLoading(true);
    try {
      const res = await fetch(`/api/fundamentals?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (dlgTicker() !== ticker) return;
      if (!res.ok) throw new Error(data.error || res.status);
      setFund(data.data || null);
      setFundError(data.error || "");
    } catch (err: any) {
      if (dlgTicker() !== ticker) return;
      setFund(null);
      setFundError("불러오기 실패: " + err.message);
    } finally {
      if (dlgTicker() === ticker) setFundLoading(false);
    }
  }

  // ── 검색 ──
  async function runSearch(q: string) {
    const seq = ++searchSeq;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (seq !== searchSeq || searchInput().trim() !== q) return;
      if (!res.ok) throw new Error(data.error || res.status);
      if (!data.items.length) {
        setSearchItems([]);
        setSearchEmpty("검색 결과가 없습니다");
      } else {
        setSearchItems(data.items);
        setSearchEmpty("");
      }
      setSearchDrop(true);
    } catch (err: any) {
      if (seq !== searchSeq) return;
      setSearchItems([]);
      setSearchEmpty("검색 실패: " + err.message);
      setSearchDrop(true);
    }
  }

  function onSearchInput(e: Event) {
    const val = (e.currentTarget as HTMLInputElement).value;
    setSearchInput(val);
    clearTimeout(searchTimer!);
    const q = val.trim();
    if (!q) { setSearchDrop(false); return; }
    searchTimer = setTimeout(() => runSearch(q), 300);
  }

  async function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      const items = searchItems();
      if (items.length) {
        pickSearch(items[0].ticker, items[0].name || "");
        return;
      }
      const q = searchInput().trim();
      if (!q) return;
      if (searchDrop() && searchEmpty()) return;
      clearTimeout(searchTimer!);
      await runSearch(q);
      const after = searchItems();
      if (after.length) pickSearch(after[0].ticker, after[0].name || "");
    } else if (e.key === "Escape") {
      setSearchDrop(false);
    }
  }

  function pickSearch(ticker: string, name: string) {
    setSearchDrop(false);
    setSearchInput("");
    openDetail(ticker, name);
  }

  // ── Changelog ──
  let clLoaded = false;
  function openChangelog() {
    setClOpen(true);
    document.body.classList.add("modal-open");
    if (!clLoaded) loadChangelog();
  }
  function closeChangelog() {
    setClOpen(false);
    document.body.classList.remove("modal-open");
  }
  function loadChangelog() {
    const escMap: Record<string, string> = {"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"};
    const esc = (s: string) => String(s||"").replace(/[<>&"']/g, c => escMap[c] ?? c);
    setClHtml('<div class="cl-loading">불러오는 중…</div>');
    fetch("/api/changelog").then(r => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(releases => {
      if (!Array.isArray(releases) || releases.length === 0) {
        setClHtml('<div class="cl-loading">아직 등록된 릴리스가 없습니다.</div>');
        clLoaded = true;
        return;
      }
      setClHtml(releases.map((r: any) => {
        const date = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString("ko-KR") : "";
        const safeBody = esc(r.body || "");
        const safeTag = esc(r.tag || r.name);
        return `<div class="cl-release">
          <div class="cl-release-head">${safeTag}<span class="cl-release-date">${date}</span></div>
          <div class="cl-release-body">${safeBody || "(릴리스 노트 없음)"}</div>
        </div>`;
      }).join(""));
      clLoaded = true;
    }).catch(() => {
      setClHtml('<div class="cl-error">이력을 불러오지 못했습니다.</div>');
    });
  }


  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (dlgOpen()) closeDetail();
      else if (clOpen()) closeChangelog();
    }
  }

  function onDocClick(e: Event) {
    if (!(e.target as HTMLElement).closest(".search")) setSearchDrop(false);
  }


  // ── 생명주기 ──
  onMount(() => {
    load();
    fetch("/api/version").then(r => r.json()).then(d => { if (d.version) setVersion(`v${d.version}`); }).catch(() => {});
    fetch("/api/stars").then(r => r.json()).then(d => { if (d.stars != null) setStarCount(d.stars); }).catch(() => {});
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("click", onDocClick);
    if (typeof window !== "undefined" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mqListener = () => { applyTheme(); if (lastChartData) drawChart(lastChartData); };
      mq.addEventListener("change", mqListener);
    }
  });

  onCleanup(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onDocClick);
    }
    if (typeof window !== "undefined" && window.matchMedia && mqListener) {
      window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", mqListener);
    }
    destroyChart();
    if (dlgTimer) clearTimeout(dlgTimer);
    if (searchTimer) clearTimeout(searchTimer);
  });

  // range 변경 시 reload — openDetail/open 안에서만
  // W2 수정: onClick의 loadDetail과 중복을 피하기 위해 effect는 사용하지 않음

  // ── 렌더 ──
  return (
    <>
      <header>
        <h1><span class="live-dot" classList={{ loading: loading() }}></span>레딧 페니주식 워치보드</h1>
        <span class="ver-badge" role="button" tabindex="0"
          onClick={openChangelog}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openChangelog(); } }}
          title="변경이력 보기">{version()}</span>
        <span class="meta">{snapshot()}</span>
        <a class="gh-badge" href="https://github.com/qkrehgus714/raddit" target="_blank" rel="noopener noreferrer" title="GitHub에서 보기">
          <svg class="gh-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          <Show when={starCount() != null}><span class="gh-stars">★ {starCount()}</span></Show>
        </a>
      </header>

      <div class="controls">
        <label>서브레딧
          <select value={filterVal()} onChange={(e) => { setFilterVal(e.currentTarget.value); load(); }}>
            <option value="all-stocks" selected>전체 주식 집계</option>
            <option value="wallstreetbets">r/wallstreetbets</option>
            <option value="pennystocks">r/pennystocks</option>
            <option value="stocks">r/stocks</option>
            <option value="investing">r/investing</option>
            <option value="shortsqueeze">r/Shortsqueeze</option>
          </select>
        </label>
        <label>가격 필터
          <select value={priceVal()} onChange={(e) => { setPriceVal(e.currentTarget.value); load(); }}>
            <option value="5" selected>$5 미만</option>
            <option value="1">$1 미만</option>
            <option value="0">전체 (필터 없음)</option>
          </select>
        </label>
        <button class="refresh" id="btn-refresh" disabled={loading()} onClick={load}>새로고침</button>
        <div class="search">
          <input
            placeholder="티커·종목명 검색 (예: TSLA, tesla)"
            autocomplete="off" spellcheck="false" aria-label="종목 검색"
            value={searchInput()}
            onInput={onSearchInput}
            onKeyDown={onSearchKeydown}
          />
          <Show when={searchDrop()}>
            <div class="search-drop">
              <Show when={!searchItems().length && searchEmpty()} fallback={
                <For each={searchItems()}>{(item) => (
                  <button type="button" onClick={() => pickSearch(item.ticker, item.name || "")}>
                    <span class="tk">{item.ticker}</span>
                    <span class="name">{item.name || ""}</span>
                    <span class="exch">{item.exchange || ""}</span>
                  </button>
                )}</For>
              }>
                <div class="empty">{searchEmpty()}</div>
              </Show>
            </div>
          </Show>
        </div>
        <span class="status" classList={{ error: statusError() }}>{status()}</span>
      </div>

      {/* 타일 */}
      <div class="tiles">
        <div class="tile">
          <div class="label">스캔한 티커</div>
          <div class="value">{tiles().scanned}<small>개</small></div>
          <div class="note">언급 2회 이상</div>
        </div>
        <div class="tile">
          <div class="label">필터 통과</div>
          <div class="value">{tiles().rowsLen}<small>종목</small></div>
          <div class="note">{tiles().maxPrice > 0 ? "$" + tiles().maxPrice + " 미만" : "가격 필터 없음"}</div>
        </div>
        <div class="tile">
          <div class="label">오늘 최고 급등</div>
          <Show when={tiles().topMover} fallback={<div class="value">-</div>}>
            {(mover) => (
              <>
                <div class="value" classList={{ up: mover().chg >= 0 }}>
                  <span class="ticker-mono">{mover().ticker}</span> {mover().chg >= 0 ? "+" : ""}{mover().chg.toFixed(1)}%
                </div>
                <div class="note">{mover().name || ""} · ${mover().price.toFixed(2)}</div>
              </>
            )}
          </Show>
        </div>
        <div class="tile">
          <div class="label">최다 언급</div>
          <Show when={tiles().topClean} fallback={<div class="value">-</div>}>
            {(clean) => (
              <>
                <div class="value"><span class="ticker-mono">{clean().ticker}</span> {clean().mentions}<small>회</small></div>
                <div class="note">{clean().name || ""}</div>
              </>
            )}
          </Show>
        </div>
      </div>

      {/* 랭킹 테이블 */}
      <div class="board">
        <div class="board-head">
          <h2>{boardTitle()}</h2>
          <span class="hint">열 제목 클릭 → 정렬 · 행 클릭 → 실시간 차트와 분석</span>
        </div>
        <div class="scroller">
          <table>
            <thead><tr>
              <For each={COLS}>{(c) => (
                <th class={c.left ? "left" : ""}
                  tabindex="0"
                  role="columnheader"
                  aria-sort={sortKey() === c.key ? (sortDir() === -1 ? "descending" : "ascending") : "none"}
                  onClick={() => toggleSort(c.key)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(c.key); } }}
                >{c.label}<span class="arrow">{sortKey() === c.key ? (sortDir() === -1 ? "▾" : "▴") : ""}</span></th>
              )}</For>
            </tr></thead>
            <tbody>
              <Show when={sortedRows().length} fallback={
                <tr><td class="empty" colspan={COLS.length}>조건에 맞는 종목이 없습니다</td></tr>
              }>
                <For each={sortedRows()}>{(d: Row) => {
                  const mv = rankMove(d);
                  const delta = d.mentions_24h_ago != null
                    ? (d.mentions - d.mentions_24h_ago >= 0 ? "+" : "") + (d.mentions - d.mentions_24h_ago)
                    : "신규";
                  const mm = maxMentions();
                  const chgHtml = d.chg != null
                    ? `<span class="pill ${d.chg > 0 ? "up" : d.chg < 0 ? "down" : "flat"}">${(d.chg > 0 ? "+" : "") + d.chg.toFixed(1)}%</span>`
                    : "-";
                  return (
                    <tr data-ticker={d.ticker} tabindex="0"
                      onClick={() => openDetail(d.ticker)}
                      onKeyDown={(e) => { if (e.key === "Enter") openDetail(d.ticker); }}
                    >
                      <td class="dim">{d.rank}</td>
                      <td class="left"><span class="tk">{d.ticker}</span><br /><span class="name">{d.name || ""}</span></td>
                      <td>{d.price != null ? "$" + d.price.toFixed(2) : "-"}</td>
                      <td innerHTML={chgHtml}></td>
                      <td>{d.bidAskPct != null ? (
                        <div class="bidask-cell" classList={{ thin: (d.bidAskTotal ?? 0) < 100 }} title={(d.bidAskTotal ?? 0) < 100 ? "호가잔량 얕음 — 참고용" : `매수 ${d.bidAskPct!.toFixed(0)}% · 매도 ${(100 - d.bidAskPct!).toFixed(0)}%`}>
                          <div class="bidask-bar"><div class="bidask-buy" style={{ width: `${d.bidAskPct}%` }}></div></div>
                          <span class="bidask-num">{d.bidAskPct.toFixed(0)}</span>
                        </div>
                      ) : "-"}</td>
                      <td>
                        <div class="mention-cell">
                          <span class="mdelta">{delta}</span>
                          <div class="mbar-track"><div class="mbar" style={{ width: `${(d.mentions / mm * 100).toFixed(0)}%` }}></div></div>
                          <span class="mnum">{d.mentions}</span>
                        </div>
                      </td>
                      <td class="dim">{d.upvotes}</td>
                      <td><span class={`pill ${mv.cls}`}>{mv.txt}</span></td>
                      <td class="dim">{fmtVol(d.vol)}</td>
                    </tr>
                  );
                }}</For>
              </Show>
            </tbody>
          </table>
        </div>
      </div>

      {/* Changelog 오버레이 */}
      <div class="cl-overlay" classList={{ open: clOpen() }} onClick={(e) => { if (e.target === e.currentTarget) closeChangelog(); }}>
        <div class="cl-panel" role="dialog" aria-modal="true" aria-labelledby="cl-title">
          <div class="cl-head">
            <h2 id="cl-title">변경이력</h2>
            <button class="cl-close" aria-label="닫기" onClick={closeChangelog}>&times;</button>
          </div>
          <div class="cl-body" innerHTML={clHtml()} />
        </div>
      </div>

      {/* 상세 모달 */}
      <div class="overlay" classList={{ open: dlgOpen() }} onClick={(e) => { if (e.target === e.currentTarget) closeDetail(); }}>
        <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-ticker-text">
          <div class="dlg-head">
            <div>
              <div class="dlg-title">
                <span class="tk" id="dlg-ticker-text">{dlgTicker()}</span>
                <span class="name">{dlgName()}</span>
              </div>
              <div class="dlg-price">
                <span class="now">{dlgPrice()}</span>
                <span innerHTML={dlgChgHtml()}></span>
              </div>
              <div class="meta">{dlgRedditInfo()}</div>
            </div>
            <button class="dlg-close" aria-label="닫기" onClick={closeDetail}>✕</button>
          </div>
          <div class="range-tabs">
            <For each={RANGES}>{([v, l]) => (
              <button class={dlgRange() === v ? "active" : ""} onClick={() => { setDlgRange(v); loadDetail(); }}>{l}</button>
            )}</For>
            <button class={"div-toggle" + (showDiv() ? " active" : "")} onClick={() => { setShowDiv((v) => !v); if (lastChartData) drawChart(lastChartData); }}>다이버전스</button>
          </div>
          <div id="chart-wrap" classList={{ dim: chartDim() }} ref={chartWrapRef}>
            <div class="chart-canvas" ref={chartContainerRef}></div>
            <div class="chart-msg" hidden={!chartMsg()}>{chartMsg()}</div>
            <div class="tip" id="chart-tip" hidden></div>
          </div>
          <div class="chart-meta">{chartMeta()}</div>
          <Show when={bidAskPct() != null}>
            <div class="dlg-bidask">
              <div class="bidask-bar"><div class="bidask-buy" style={{ width: `${bidAskPct()}%` }}></div></div>
              <div class="bidask-label">호가 잔량 매수 {bidAskPct()!.toFixed(0)}% · 매도 {(100 - bidAskPct()!).toFixed(0)}%</div>
            </div>
          </Show>
          <Show when={stEnabled() && stSent()} fallback={<Show when={stEnabled() && stEmpty()}><p class="dlg-status">{stEmpty()}</p></Show>}>
            <h3 class="dlg-sub">StockTwits 여론 <Show when={stSent()!.tagged > 0}><span class="sent-note">{stSent()!.bullish_pct!.toFixed(0)}% 매수 · {(100 - stSent()!.bullish_pct!).toFixed(0)}% 매도 (태그 {stSent()!.tagged}건)</span></Show></h3>
            <Show when={(stSent()!.tagged ?? 0) > 0}>
              <div class="sent-bar"><div class="sent-bull" style={{ width: `${stSent()!.bullish_pct}%` }}></div></div>
            </Show>
            <Show when={stSent()!.messages.length} fallback={<p class="dlg-status">최근 메시지가 없습니다</p>}>
              <ul class="post-list">
                <For each={stSent()!.messages}>{(m) => (
                  <li>
                    <span class="st-body">{m.body}</span>
                    <span class="post-meta">{["@" + m.username, timeAgo(m.ts), m.sentiment === "Bullish" ? "매수" : m.sentiment === "Bearish" ? "매도" : null].filter(Boolean).join(" · ")}</span>
                  </li>
                )}</For>
              </ul>
            </Show>
          </Show>
          <div class="dlg-status">{dlgStatus()}</div>
          <h3 class="dlg-sub">기술적 분석</h3>
          <p class="dlg-summary">{dlgSummary()}</p>
          <div class="ind-grid">
            <For each={dlgIndicators()}>{([label, value]) => (
              <div class="ind"><div class="label">{label}</div><div class="value">{value}</div></div>
            )}</For>
          </div>
          <ul class="sig-list">
            <For each={dlgSignals()}>{(s) => (
              <li>
                <span class={`pill ${s.tone === "up" ? "up" : s.tone === "down" ? "down" : "flat"}`}>{s.label}</span>
                <span>{s.text}</span>
              </li>
            )}</For>
          </ul>
          <h3 class="dlg-sub">레딧 게시물 (최근 1개월)</h3>
          <ul class="post-list">
            <Show when={redditPosts().length} fallback={<li class="post-empty">{redditEmpty()}</li>}>
              <For each={redditPosts()}>{(p) => (
                <li>
                  <a href={p.url || "#"} target="_blank" rel="noopener noreferrer">{p.title || "(제목 없음)"}</a>
                  <span class="post-meta">{["r/" + (p.subreddit || "").replace(/^r\//, ""), timeAgo(p.ts)].filter(Boolean).join(" · ")}</span>
                </li>
              )}</For>
            </Show>
          </ul>
          <h3 class="dlg-sub">관련 뉴스</h3>
          <ul class="post-list">
            <Show when={newsPosts().length} fallback={<li class="post-empty">{newsEmpty()}</li>}>
              <For each={newsPosts()}>{(p) => (
                <li>
                  <a href={p.url || "#"} target="_blank" rel="noopener noreferrer">{p.title || "(제목 없음)"}</a>
                  <span class="post-meta">{[p.publisher, timeAgo(p.ts || null)].filter(Boolean).join(" · ")}</span>
                </li>
              )}</For>
            </Show>
          </ul>
          <Show when={fundLoading()}><p class="dlg-status">재무/공시 불러오는 중…</p></Show>
          <Show when={fundError()}><p class="dlg-status">{fundError()}</p></Show>
          <Show when={!fundLoading()}>
            <Show when={fund()?.cik} fallback={<p class="dlg-status">SEC 공시 의무 없음 (OTC/소형주 가능)</p>}>
              <h3 class="dlg-sub">재무 하이라이트 <Show when={fund()?.financials?.as_of}><span class="dlg-note">{fund()!.financials!.as_of} 기준</span></Show></h3>
              <Show when={fund()?.financials} fallback={<p class="dlg-status">재무 데이터가 없습니다</p>}>
                <div class="ind-grid">
                  <div class="ind"><div class="label">매출 TTM</div><div class="value">{fmtM(fund()!.financials!.revenues_ttm)}</div></div>
                  <div class="ind"><div class="label">순이익 TTM</div><div class="value">{fmtM(fund()!.financials!.net_income_ttm)}</div></div>
                  <div class="ind"><div class="label">총자산</div><div class="value">{fmtM(fund()!.financials!.total_assets)}</div></div>
                  <div class="ind"><div class="label">EPS</div><div class="value">{fund()!.financials!.eps != null ? "$" + fund()!.financials!.eps.toFixed(2) : "-"}</div></div>
                  <div class="ind"><div class="label">현금·단기투자</div><div class="value">{fmtM(fund()!.financials!.cash)}</div></div>
                  <div class="ind"><div class="label">영업현금흐름 TTM</div><div class="value">{fmtM(fund()!.financials!.operating_cf_ttm)}</div></div>
                </div>
              </Show>
              <h3 class="dlg-sub">SEC 공시</h3>
              <Show when={(fund()?.filings.length ?? 0) > 0} fallback={<p class="dlg-status">최근 관련 공시가 없습니다</p>}>
                <ul class="post-list">
                  <For each={fund()!.filings}>{(f) => (
                    <li>
                      <a href={f.url} target="_blank" rel="noopener noreferrer">{f.form}{f.docDesc ? " · " + f.docDesc : ""}</a>
                      <span class="post-meta">{f.date}</span>
                    </li>
                  )}</For>
                </ul>
              </Show>
            </Show>
          </Show>
          <p class="disclaimer">1년 일봉 기준으로 자동 계산된 참고 지표이며, 투자 판단의 근거가 아닙니다.</p>
        </div>
      </div>

      {/* 푸터 */}
      <footer>
        <h3>데이터 수집 방식</h3>
        <ul>
          <li>ApeWisdom이 주요 주식 서브레딧을 30분마다 스캔해 대문자(AMD)·$ 접두사($aapl) 패턴으로 티커를 집계합니다. 이 서버가 새로고침마다 그 API와 Yahoo Finance를 대신 호출합니다 (2분 캐시).</li>
          <li>EU, IQ, API처럼 일반 단어·약어와 겹쳐 잘못 집계될 가능성이 높은 티커는 목록에서 자동으로 제외합니다.</li>
        </ul>
        <p class="disclaimer">언급량은 관심도 지표일 뿐 투자 판단의 근거가 아닙니다. 페니주식은 변동성과 조작 위험이 큽니다.</p>
      </footer>
    </>
  );
}
