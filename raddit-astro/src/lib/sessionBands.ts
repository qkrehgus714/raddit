/**
 * 분봉 차트 위 프리/애프터마켓 세션 음영 밴드 (lightweight-charts v5 series primitive).
 * 이슈 #48. 토요/일요일은 밴드 없음 (미국 시장 휴장).
 */
import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  IChartApi,
  Time,
} from "lightweight-charts";

export interface SessionBand {
  /** 시작/끝 unix 초 (둘 다 NY 벽시계 기준 세션 경계) */
  from: number;
  to: number;
}

interface BandX {
  x1: number;
  x2: number;
}

class SessionBandsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly _bands: BandX[], private readonly _color: string) {}
  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D;
      const pr = scope.horizontalPixelRatio as number;
      ctx.fillStyle = this._color;
      for (const b of this._bands) {
        const x1 = Math.min(b.x1, b.x2) * pr;
        const w = Math.abs(b.x2 - b.x1) * pr;
        if (w <= 0) continue;
        ctx.fillRect(x1, 0, w, scope.bitmapSize.height as number);
      }
    });
  }
}

class SessionBandsPaneView implements IPrimitivePaneView {
  private _sessions: SessionBand[] = [];
  constructor(private readonly _chart: IChartApi, private readonly _color: string) {}
  setSessions(s: SessionBand[]): void {
    this._sessions = s;
  }
  zOrder() {
    return "bottom" as const;
  }
  renderer(): IPrimitivePaneRenderer | null {
    const ts = this._chart.timeScale();
    const mapped: BandX[] = [];
    for (const s of this._sessions) {
      const x1 = ts.timeToCoordinate(s.from as Time);
      const x2 = ts.timeToCoordinate(s.to as Time);
      if (x1 === null || x2 === null) continue;
      if (Math.abs(x2 - x1) < 0.5) continue;
      mapped.push({ x1, x2 });
    }
    return new SessionBandsRenderer(mapped, this._color);
  }
}

export class SessionBandsPrimitive implements ISeriesPrimitive {
  private _chart: IChartApi | null = null;
  private _view: SessionBandsPaneView | null = null;
  private readonly _color: string;
  constructor(color: string) {
    this._color = color;
  }
  attached(param: SeriesAttachedParameter): void {
    this._chart = param.chart;
    this._view = new SessionBandsPaneView(param.chart, this._color);
  }
  detached(): void {
    this._chart = null;
    this._view = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this._view ? [this._view] : [];
  }
  updateAllViews(): void {
    /* no-op: 좌표 매핑은 draw 시점에 renderer() 안에서 수행 */
  }
  /** 세션 목록 교체. unix 초 단위 SessionBand[]. 빈 배열이면 밴드 제거. */
  setSessions(s: SessionBand[]): void {
    this._view?.setSessions(s);
    this._chart?.applyOptions({}); // 강제 재페인트
  }
}

/** America/New_York 벽시계 (y,mo,da,h,mi) → UTC unix 초 (DST 자동). */
function nyWallToUtcSec(y: number, mo: number, da: number, h: number, mi: number): number | null {
  const naive = Math.floor(Date.UTC(y, mo, da, h, mi) / 1000);
  const partsFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  for (const offHours of [4, 5]) {
    const cand = naive + offHours * 3600;
    const parts = partsFmt.formatToParts(new Date(cand * 1000));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const H = Number(get("hour"));
    const hh = H === 24 ? 0 : H; // midnight edge case
    if (Number(get("month")) - 1 === mo && Number(get("day")) === da && hh === h && Number(get("minute")) === mi) {
      return cand;
    }
  }
  return null;
}

/**
 * [firstT, lastT] 구간의 미국 거래일마다 프리(04:00–09:30) · 애프터(16:00–20:00) 밴드 생성.
 * 주말(토/일 NY) 은 제외. firstT/lastT: unix 초.
 */
export function computeIntradaySessions(firstT: number, lastT: number): SessionBand[] {
  const bands: SessionBand[] = [];
  const dayMs = 86400000;
  const cursor = new Date(firstT * 1000);
  cursor.setUTCHours(0, 0, 0, 0);
  const endMs = lastT * 1000;
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
  for (let d = cursor.getTime(); d <= endMs; d += dayMs) {
    const dt = new Date(d);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth(), da = dt.getUTCDate();
    // NY 기준 요일로 주말 제외 (정오 UTC 사용 — NY의 같은 달력일 보장)
    const wd = dowFmt.format(new Date(Date.UTC(y, mo, da, 12)));
    if (wd === "Sat" || wd === "Sun") continue;
    const pre = nyWallToUtcSec(y, mo, da, 4, 0);
    const rOpen = nyWallToUtcSec(y, mo, da, 9, 30);
    const rClose = nyWallToUtcSec(y, mo, da, 16, 0);
    const ahEnd = nyWallToUtcSec(y, mo, da, 20, 0);
    if (pre != null && rOpen != null) bands.push({ from: pre, to: rOpen });
    if (rClose != null && ahEnd != null) bands.push({ from: rClose, to: ahEnd });
  }
  return bands;
}
