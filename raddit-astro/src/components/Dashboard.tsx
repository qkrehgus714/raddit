// raddit 메인 대시보드 — SolidJS 컴포넌트
// dashboard.html 1,126줄을 컴포넌트화. 모든 기능 100% 동등.
import { createSignal, onMount, onCleanup, createMemo, Show, For } from "solid-js";

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
  const [bidAskPct, setBidAskPct] = createSignal<number | null>(null);

  // 게시물
  const [redditPosts, setRedditPosts] = createSignal<{title:string;url:string|null;subreddit:string|null;ts:number|null}[]>([]);
  const [redditEmpty, setRedditEmpty] = createSignal("");
  const [newsPosts, setNewsPosts] = createSignal<{title:string;publisher?:string;url?:string;ts?:number}[]>([]);
  const [newsEmpty, setNewsEmpty] = createSignal("");

  // Changelog
  const [clOpen, setClOpen] = createSignal(false);
  const [clHtml, setClHtml] = createSignal('<div class="cl-loading">불러오는 중…</div>');

  // 검색
  const [searchInput, setSearchInput] = createSignal("");
  const [searchDrop, setSearchDrop] = createSignal(false);
  const [searchItems, setSearchItems] = createSignal<{ticker:string;name:string|null;exchange:string|null}[]>([]);
  const [searchEmpty, setSearchEmpty] = createSignal("");

  // refs
  let canvasRef: HTMLCanvasElement | undefined;
  let chartWrapRef: HTMLDivElement | undefined;
  let chartState: any = null;
  let lastDetail: any = null;
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
      const filtered = data.items.filter((d: Row) => !FALSE_POSITIVE.has(d.ticker)).map((d: Row) => ({
        ...d,
        price: d.quote ? d.quote.price : null,
        chg: d.quote ? d.quote.day_change_pct : null,
        vol: d.quote ? d.quote.volume : null,
      }));
      setRows(filtered);
      setScanned(data.scanned);
      setSnapshot(`${data.generated_at} 기준`);
      setBoardTitle(
        `${FILTER_NAMES[filterVal()] || filterVal()} 언급 상위` +
        (priceVal() > "0" ? ` 페니주식 (<$${priceVal()})` : " 종목") + ` · ${filtered.length}개`
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

  // ── 정렬 ──
  function clearChart(msg?: string) {
    chartState = null; lastDetail = null; hideTip();
    const cv = canvasRef, wrap = chartWrapRef;
    if (!cv || !wrap) return;
    const w = wrap.clientWidth, h = 280, dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (msg) {
      ctx.fillStyle = cssVar("--ink-3"); ctx.font = "13px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(msg, w / 2, h / 2);
    }
    setChartMeta("");
  }

  function hideTip() {
    const hl = document.getElementById("hairline");
    const tip = document.getElementById("chart-tip");
    if (hl) hl.hidden = true;
    if (tip) tip.hidden = true;
  }

  function drawChart(data: any) {
    const cv = canvasRef, wrap = chartWrapRef;
    if (!cv || !wrap) return;
    const w = wrap.clientWidth, h = 280, dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    chartState = null; hideTip();

    const pts = data.points || [];
    if (pts.length < 2) {
      ctx.fillStyle = cssVar("--ink-3"); ctx.font = "13px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("표시할 시세 데이터가 없습니다", w / 2, h / 2);
      setChartMeta("");
      return;
    }

    const M = { l: 10, r: 64, t: 14, b: 22 }, volH = 36;
    const plotW = w - M.l - M.r, plotH = h - M.t - M.b;
    const closes = pts.map((p: any) => p.c);
    const highs = pts.map((p: any) => p.h != null ? p.h : p.c);
    const lows = pts.map((p: any) => p.l != null ? p.l : p.c);
    const baseline = data.range === "min" && data.prev_close ? data.prev_close : pts[0].c;
    let lo = Math.min(...lows, baseline), hi = Math.max(...highs, baseline);
    const pad = (hi - lo) * 0.06 || hi * 0.02 || 0.01;
    lo -= pad; hi += pad;
    const slot = plotW / pts.length;
    const x = (i: number) => M.l + (i + 0.5) * slot;
    const y = (v: number) => M.t + (hi - v) / (hi - lo) * plotH;
    const up = closes[closes.length - 1] >= baseline;
    const lineColor = up ? cssVar("--up") : cssVar("--down");
    const upColor = cssVar("--up"), downColor = cssVar("--down");
    const gridColor = cssVar("--line"), ink3 = cssVar("--ink-3");

    // 가로 그리드
    ctx.font = "11px Consolas, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (let g = 0; g <= 3; g++) {
      const v = hi - (hi - lo) * g / 3, gy = y(v);
      ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M.l, gy); ctx.lineTo(w - M.r, gy); ctx.stroke();
      ctx.fillStyle = ink3;
      ctx.fillText(fmtPrice(v), w - M.r + 8, gy);
    }

    // 프리·애프터마켓
    if (data.range === "min" && data.regular_start && data.regular_end) {
      let i0 = pts.findIndex((p: any) => p.t >= data.regular_start);
      if (i0 === -1) i0 = pts.length;
      let i1 = pts.findIndex((p: any) => p.t >= data.regular_end);
      if (i1 === -1) i1 = pts.length;
      const xAt = (i: number) => M.l + Math.max(0, Math.min(pts.length, i)) * slot;
      ctx.font = "10px 'Segoe UI', sans-serif"; ctx.textBaseline = "top"; ctx.textAlign = "left";
      const band = (x0: number, x1: number, label: string) => {
        if (x1 - x0 < 2) return;
        ctx.fillStyle = ink3; ctx.globalAlpha = 0.09;
        ctx.fillRect(x0, M.t, x1 - x0, plotH);
        ctx.globalAlpha = 1;
        if (x1 - x0 > 44) { ctx.fillStyle = ink3; ctx.fillText(label, x0 + 5, M.t + 4); }
      };
      band(M.l, xAt(i0), "프리마켓");
      band(xAt(i1), w - M.r, "애프터마켓");
      ctx.font = "11px Consolas, monospace"; ctx.textBaseline = "middle";
    }

    // 거래량 바
    const maxVol = Math.max(...pts.map((p: any) => p.v || 0));
    if (maxVol > 0) {
      ctx.fillStyle = cssVar("--bar"); ctx.globalAlpha = 0.35;
      const bw = Math.max(slot - 1, 0.5);
      pts.forEach((p: any, i: number) => {
        if (!p.v) return;
        const bh = p.v / maxVol * volH;
        ctx.fillRect(x(i) - bw / 2, M.t + plotH - bh, bw, bh);
      });
      ctx.globalAlpha = 1;
    }

    // 기준선
    ctx.setLineDash([4, 4]); ctx.strokeStyle = ink3; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.l, y(baseline)); ctx.lineTo(w - M.r, y(baseline)); ctx.stroke();
    ctx.setLineDash([]);

    // 오버레이 (이동평균·볼린저)
    const maFast = cssVar("--accent"), maSlow = cssVar("--ma-slow");
    let ovLegend: [string, string, number[]][] | null = null;
    if (data.overlays && data.overlays.length) {
      const byT = new Map(data.overlays.map((o: any) => [o.t, o]));
      const val = (p: any, k: string) => { const o = byT.get(p.t); return o && o[k] != null ? o[k] : null; };
      ctx.save();
      ctx.beginPath(); ctx.rect(M.l, M.t, plotW, plotH); ctx.clip();
      let run: [number, number, number][] = [];
      const flushBand = () => {
        if (run.length >= 2) {
          ctx.beginPath();
          run.forEach(([i, u], j) => j ? ctx.lineTo(x(i), y(u)) : ctx.moveTo(x(i), y(u)));
          for (let j = run.length - 1; j >= 0; j--) ctx.lineTo(x(run[j][0]), y(run[j][2]));
          ctx.closePath();
          ctx.fillStyle = ink3; ctx.globalAlpha = 0.08; ctx.fill(); ctx.globalAlpha = 1;
        }
        run = [];
      };
      pts.forEach((p: any, i: number) => {
        const u = val(p, "bu"), l = val(p, "bl");
        if (u != null && l != null) run.push([i, u, l]); else flushBand();
      });
      flushBand();
      const drawMA = (key: string, color: string, dash: number[]) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
        ctx.setLineDash(dash);
        ctx.beginPath();
        let started = false;
        pts.forEach((p: any, i: number) => {
          const v = val(p, key);
          if (v == null) { started = false; return; }
          if (started) ctx.lineTo(x(i), y(v)); else { ctx.moveTo(x(i), y(v)); started = true; }
        });
        ctx.stroke();
        ctx.setLineDash([]);
      };
      drawMA("s20", maFast, []);
      drawMA("s50", maSlow, [2, 3]);
      ctx.restore();
      ovLegend = [["20일선", maFast, []], ["50일선", maSlow, [2, 3]], ["볼린저(20·2σ)", ink3, []]];
    }

    // 캔들스틱
    const bodyW = Math.max(Math.min(slot * 0.65, 12), 1.5);
    pts.forEach((p: any, i: number) => {
      const o = p.o != null ? p.o : p.c;
      const hh = p.h != null ? p.h : Math.max(o, p.c);
      const ll = p.l != null ? p.l : Math.min(o, p.c);
      const color = p.c >= o ? upColor : downColor;
      const cx = x(i);
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(hh)); ctx.lineTo(cx, y(ll)); ctx.stroke();
      const yO = y(o), yC = y(p.c);
      ctx.fillStyle = color;
      ctx.fillRect(cx - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(Math.abs(yO - yC), 1));
    });

    // 오버레이 범례
    if (ovLegend) {
      ctx.font = "10px 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      let lx0 = M.l + 6;
      const lyy = M.t + 8;
      ovLegend.forEach(([label, color, dash]) => {
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(lx0, lyy); ctx.lineTo(lx0 + 14, lyy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ink3;
        ctx.fillText(label, lx0 + 18, lyy);
        lx0 += 18 + ctx.measureText(label).width + 14;
      });
    }

    // 현재가 태그
    const last = closes[closes.length - 1], ly = y(last);
    ctx.fillStyle = lineColor;
    ctx.font = "bold 11px Consolas, monospace";
    const tag = fmtPrice(last), tw = ctx.measureText(tag).width;
    ctx.beginPath(); ctx.roundRect(w - M.r + 4, ly - 9, tw + 8, 18, 4); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(tag, w - M.r + 8, ly);

    // X축
    const tz = "Asia/Seoul";
    const AXIS_OPT: Record<string, any> = {
      min:   { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
      day:   { month: "numeric", day: "numeric" },
      week:  { year: "2-digit", month: "numeric" },
      month: { year: "numeric" },
      year:  { year: "numeric" },
    };
    const TIP_OPT: Record<string, any> = {
      min:   { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
      day:   { year: "numeric", month: "numeric", day: "numeric" },
      week:  { year: "numeric", month: "numeric", day: "numeric" },
      month: { year: "numeric", month: "numeric" },
      year:  { year: "numeric", month: "numeric" },
    };
    const axisFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: tz, ...(AXIS_OPT[data.range] || AXIS_OPT.day) });
    const tipFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: tz, ...(TIP_OPT[data.range] || TIP_OPT.day) });
    ctx.fillStyle = ink3; ctx.font = "11px 'Segoe UI', sans-serif"; ctx.textBaseline = "top";
    [0, 1/3, 2/3, 1].forEach(f => {
      const i = Math.round(f * (pts.length - 1));
      ctx.textAlign = f === 0 ? "left" : f === 1 ? "right" : "center";
      ctx.fillText(axisFmt.format(new Date(pts[i].t * 1000)), x(i), M.t + plotH + 7);
    });

    const rangeHi = Math.max(...highs), rangeLo = Math.min(...lows);
    const span = `${tipFmt.format(new Date(pts[0].t * 1000))} ~ ${tipFmt.format(new Date(pts[pts.length - 1].t * 1000))}`;
    setChartMeta(
      `${CANDLE_LABEL[data.range] || ""} ${span}` +
      ` · 고가 ${fmtPrice(rangeHi)} · 저가 ${fmtPrice(rangeLo)}` +
      (data.range === "min" && data.prev_close ? ` · 전일 종가 ${fmtPrice(data.prev_close)} (점선)` : " · 점선은 구간 시작가") +
      " · 한국시간 기준" + (data.range === "min" ? ", 프리·애프터마켓 포함" : "")
    );
    chartState = { pts, x, y, M, w, h, slot, tipFmt };
  }

  // ── 상세 모달 ──
  function openDetail(ticker: string, fallbackName?: string) {
    const d = rows().find(r => r.ticker === ticker) || null;
    setDlgTicker(ticker); setDlgRange("min"); lastDetail = null;
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
  }

  function closeDetail() {
    setDlgTicker(""); dlgSeq++;
    clearTimeout(dlgTimer!); dlgTimer = null;
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
      lastDetail = data;
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
    try {
      const res = await fetch(`/api/posts?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (dlgTicker() !== ticker) return;
      if (!res.ok) throw new Error(data.error || res.status);
      setRedditPosts(data.reddit || []);
      setRedditEmpty(data.reddit_error ? "레딧 불러오기 실패 (잠시 후 다시 시도해 주세요)" : "최근 1개월 내 관련 게시물이 없습니다");
      setNewsPosts(data.news || []);
      setNewsEmpty(data.news_error ? "뉴스 불러오기 실패" : "관련 뉴스가 없습니다");
    } catch (err: any) {
      if (dlgTicker() !== ticker) return;
      setRedditPosts([]); setRedditEmpty("불러오기 실패: " + err.message);
      setNewsPosts([]); setNewsEmpty("불러오기 실패: " + err.message);
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
    const esc = (s: string) => String(s||"").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
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

  // ── 차트 호버 ──
  function onChartMove(e: PointerEvent) {
    if (!chartState || !canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const { pts, M, w, h, slot } = chartState;
    const i = Math.max(0, Math.min(pts.length - 1, Math.floor((px - M.l) / slot)));
    const cx = chartState.x(i);
    const hl = document.getElementById("hairline");
    if (hl) { hl.hidden = false; hl.style.left = cx + "px"; hl.style.top = M.t + "px"; hl.style.height = (h - M.t - M.b) + "px"; }
    const tip = document.getElementById("chart-tip");
    if (tip) {
      tip.hidden = false; tip.innerHTML = "";
      const p = pts[i], o = p.o != null ? p.o : p.c;
      const strong = document.createElement("strong"); strong.textContent = fmtPrice(p.c);
      const ohlc = document.createElement("span");
      ohlc.textContent = `시 ${fmtPrice(o)} · 고 ${fmtPrice(p.h != null ? p.h : p.c)} · 저 ${fmtPrice(p.l != null ? p.l : p.c)}`;
      const sub = document.createElement("span");
      sub.textContent = chartState.tipFmt.format(new Date(p.t * 1000)) + (p.v ? " · 거래량 " + fmtVol(p.v) : "");
      tip.append(strong, ohlc, sub);
      tip.style.left = Math.min(cx + 12, w - tip.offsetWidth - 8) + "px";
      const ty = chartState.y(p.c);
      tip.style.top = (ty - 64 < 4 ? ty + 14 : ty - 64) + "px";
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (dlgOpen()) closeDetail();
      else if (clOpen()) closeChangelog();
    }
  }

  function onResize() {
    if (lastDetail && dlgOpen()) drawChart(lastDetail);
  }

  // ── 생명주기 ──
  onMount(() => {
    load();
    // 버전
    fetch("/api/version").then(r => r.json()).then(d => { if (d.version) setVersion(`v${d.version}`); }).catch(() => {});
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", onResize);
    // W1: 검색 영역 외부 클릭 시 드롭다운 닫기
    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".search")) setSearchDrop(false);
    });
  });

  onCleanup(() => {
    if (typeof document !== "undefined") document.removeEventListener("keydown", onKeydown);
    if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
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
          <div class="note">{tiles().maxPrice > "0" ? "$" + tiles().maxPrice + " 미만" : "가격 필터 없음"}</div>
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
          </div>
          <div id="chart-wrap" classList={{ dim: chartDim() }} ref={chartWrapRef}
            onPointerMove={onChartMove}
            onPointerLeave={hideTip}
          >
            <canvas ref={canvasRef}></canvas>
            <div class="hairline" id="hairline" hidden></div>
            <div class="tip" id="chart-tip" hidden></div>
          </div>
          <div class="chart-meta">{chartMeta()}</div>
          <Show when={bidAskPct() != null}>
            <div class="dlg-bidask">
              <div class="bidask-bar"><div class="bidask-buy" style={{ width: `${bidAskPct()}%` }}></div></div>
              <div class="bidask-label">호가 잔량 매수 {bidAskPct()!.toFixed(0)}% · 매도 {(100 - bidAskPct()!).toFixed(0)}%</div>
            </div>
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
