/** 기술 지표 계산 — penny_mentions.py의 분석 로직을 그대로 이식. */

// 차트 범위별 봉 간격 (Yahoo Finance chart API 파라미터)
// 캔들이 읽히려면 화면에 봉이 너무 많으면 안 됨 — 1일은 15분봉(~64개), 5일은 1시간봉(~33개)
export const RANGE_INTERVAL: Record<string, string> = {
  "1d": "15m", "5d": "60m", "1mo": "1d", "6mo": "1d", "1y": "1d",
};

export interface Point {
  t: number; o: number; h: number; l: number; c: number; v: number | null;
}

export interface Signal { tone: "up" | "down" | "flat"; label: string; text: string; }

export interface Analysis {
  summary: string;
  signals: Signal[];
  indicators: Record<string, number | string | null>;
}

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let gains = 0, losses = 0;
  const prev = closes.slice(-n - 1, -1), cur = closes.slice(-n);
  for (let i = 0; i < n; i++) {
    const diff = cur[i] - prev[i];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

/** n일 지수이동평균 시계열 — values[n-1:] 구간에 정렬돼 반환. */
function emaSeries(values: number[], n: number): number[] | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let ema = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const out = [ema];
  for (const v of values.slice(n)) {
    ema = v * k + (1 - k) * ema;
    out.push(ema);
  }
  return out;
}

interface MacdResult { hist: number; cross: { days_ago: number; golden: boolean } | null; }

/** MACD(12·26·9) — 마지막 히스토그램 값과 가장 최근 시그널선 교차. */
function macd(closes: number[]): MacdResult | null {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  if (!e12 || !e26) return null;
  const line = e12.slice(-e26.length).map((a, i) => a - e26[i]);
  const sig = emaSeries(line, 9);
  if (!sig) return null;
  const hist = line.slice(-sig.length).map((m, i) => m - sig[i]);
  let cross: MacdResult["cross"] = null;
  for (let i = hist.length - 1; i > 0; i--) {
    if ((hist[i] >= 0) !== (hist[i - 1] >= 0)) {
      cross = { days_ago: hist.length - 1 - i, golden: hist[i] >= 0 };
      break;
    }
  }
  return { hist: hist[hist.length - 1], cross };
}

interface BollingerResult { pctb: number | null; width: number | null; squeeze: boolean; }

/** 볼린저밴드(20일, 2σ) — %B, 밴드 폭(%), 스퀴즈(폭이 최근 하위 20%) 여부. */
function bollinger(closes: number[], n = 20, k = 2.0): BollingerResult | null {
  if (closes.length < n) return null;
  const widths: number[] = [];
  for (let i = n; i <= closes.length; i++) {
    const win = closes.slice(i - n, i);
    const mid = win.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(win.reduce((a, c) => a + (c - mid) ** 2, 0) / n);
    if (mid) widths.push((2 * k * sd) / mid * 100);
  }
  const win = closes.slice(-n);
  const mid = win.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(win.reduce((a, c) => a + (c - mid) ** 2, 0) / n);
  const upper = mid + k * sd, lower = mid - k * sd;
  const pctb = upper > lower ? ((closes[closes.length - 1] - lower) / (upper - lower)) * 100 : null;
  const width = widths.length ? widths[widths.length - 1] : null;
  const recent = widths.slice(-120);
  const squeeze = width != null && recent.length >= 60 &&
    width <= [...recent].sort((a, b) => a - b)[Math.max(0, Math.floor(recent.length / 5) - 1)];
  return { pctb, width, squeeze };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export interface OverlayRow {
  t: number; s20: number | null; s50: number | null; bu: number | null; bl: number | null;
}

/**
 * 일봉 차트에 겹칠 20·50일 이동평균 + 볼린저밴드 시계열.
 * 반환: [{t, s20, s50, bu, bl}, ...] — 이력이 부족한 앞부분은 null.
 */
export function computeOverlays(dailyPoints: Point[], k = 2.0): OverlayRow[] {
  const closes = dailyPoints.map(p => p.c);
  return dailyPoints.map((p, i) => {
    const row: OverlayRow = { t: p.t, s20: null, s50: null, bu: null, bl: null };
    if (i + 1 >= 20) {
      const win = closes.slice(i - 19, i + 1);
      const mid = win.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(win.reduce((a, c) => a + (c - mid) ** 2, 0) / 20);
      row.s20 = round4(mid);
      row.bu = round4(mid + k * sd);
      row.bl = round4(mid - k * sd);
    }
    if (i + 1 >= 50) {
      row.s50 = round4(closes.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50);
    }
    return row;
  });
}

/** 1년치 일봉으로 기술 지표를 계산하고 한국어 시그널로 요약한다. */
export function analyze(dailyPoints: Point[], meta: Record<string, unknown>): Analysis {
  const closes = dailyPoints.map(p => p.c);
  const volumes = dailyPoints.filter(p => p.v).map(p => p.v as number);
  if (closes.length < 5) {
    return { summary: "시세 데이터가 부족해 분석할 수 없습니다.", signals: [], indicators: {} };
  }

  const metaPrice = meta.regularMarketPrice as number | undefined;
  const price = metaPrice || closes[closes.length - 1];
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
  const rsi14 = rsi(closes);
  const hi52 = Math.max(...closes), lo52 = Math.min(...closes);
  const pos52 = hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : null;
  const metaVol = meta.regularMarketVolume as number | undefined;
  const volNow = metaVol || (volumes.length ? volumes[volumes.length - 1] : null);
  const avgVol = volumes.length ? sma(volumes, Math.min(20, volumes.length)) : null;
  const volRatio = volNow && avgVol ? volNow / avgVol : null;
  const recent = closes.slice(-21);
  const moves: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1]) moves.push(Math.abs(recent[i] / recent[i - 1] - 1) * 100);
  }
  const volatility = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
  const m = macd(closes);
  const bb = bollinger(closes);

  const signals: Signal[] = [];
  let score = 0;
  if (sma20 && sma50) {
    if (price > sma20 && sma20 > sma50) {
      signals.push({ tone: "up", label: "추세", text: "20·50일 이동평균선 위 — 단·중기 상승 추세" });
      score += 1;
    } else if (price < sma20 && sma20 < sma50) {
      signals.push({ tone: "down", label: "추세", text: "20·50일 이동평균선 아래 — 단·중기 하락 추세" });
      score -= 1;
    } else {
      signals.push({ tone: "flat", label: "추세", text: "이동평균선이 엇갈려 방향성이 뚜렷하지 않음" });
    }
  }
  if (rsi14 != null) {
    if (rsi14 >= 70) {
      signals.push({ tone: "down", label: "RSI", text: `RSI ${rsi14.toFixed(0)} — 과매수 구간, 단기 조정 유의` });
      score -= 1;
    } else if (rsi14 <= 30) {
      signals.push({ tone: "up", label: "RSI", text: `RSI ${rsi14.toFixed(0)} — 과매도 구간, 기술적 반등 여지` });
      score += 1;
    } else {
      signals.push({ tone: "flat", label: "RSI", text: `RSI ${rsi14.toFixed(0)} — 중립 구간` });
    }
  }
  let macdText: string | null = null;
  if (m) {
    const cross = m.cross;
    if (cross && cross.days_ago <= 30) {
      const when = cross.days_ago === 0 ? "오늘" : `${cross.days_ago}일 전`;
      macdText = (cross.golden ? "골든" : "데드") + `크로스 ${when}`;
    } else {
      macdText = m.hist > 0 ? "상승 모멘텀" : "하락 모멘텀";
    }
    if (cross && cross.days_ago <= 5) {
      const when = cross.days_ago === 0 ? "오늘" : `${cross.days_ago}일 전`;
      if (cross.golden) {
        signals.push({ tone: "up", label: "MACD", text: `골든크로스 ${when} 발생 — 모멘텀 상승 전환` });
        score += 1;
      } else {
        signals.push({ tone: "down", label: "MACD", text: `데드크로스 ${when} 발생 — 모멘텀 하락 전환` });
        score -= 1;
      }
    } else if (m.hist > 0) {
      signals.push({ tone: "up", label: "MACD", text: "MACD가 시그널선 위 — 상승 모멘텀 유지 중" });
    } else {
      signals.push({ tone: "down", label: "MACD", text: "MACD가 시그널선 아래 — 하락 모멘텀 지속" });
    }
  }
  if (bb && bb.pctb != null) {
    if (bb.pctb > 100) {
      signals.push({ tone: "down", label: "볼린저", text: `상단 밴드 이탈 (%B ${bb.pctb.toFixed(0)}) — 단기 과열` });
      score -= 1;
    } else if (bb.pctb < 0) {
      signals.push({ tone: "up", label: "볼린저", text: `하단 밴드 이탈 (%B ${bb.pctb.toFixed(0)}) — 과매도, 반등 여지` });
      score += 1;
    }
    if (bb.squeeze) {
      signals.push({ tone: "flat", label: "볼린저", text: "밴드 폭이 최근 6개월 최저 수준으로 수축 — 큰 변동 임박 가능" });
    }
  }
  if (pos52 != null) {
    if (pos52 >= 80) {
      signals.push({ tone: "up", label: "52주", text: `52주 범위 상단 ${pos52.toFixed(0)}% 지점 — 고점 부근` });
    } else if (pos52 <= 20) {
      signals.push({ tone: "down", label: "52주", text: `52주 범위 하단 ${pos52.toFixed(0)}% 지점 — 저점 부근` });
    } else {
      signals.push({ tone: "flat", label: "52주", text: `52주 범위의 ${pos52.toFixed(0)}% 지점` });
    }
  }
  if (volRatio != null) {
    if (volRatio >= 3) {
      signals.push({ tone: "up", label: "거래량", text: `20일 평균의 ${volRatio.toFixed(1)}배 — 거래 폭증, 관심 급등` });
      score += 1;
    } else if (volRatio >= 1.5) {
      signals.push({ tone: "up", label: "거래량", text: `20일 평균의 ${volRatio.toFixed(1)}배 — 평소보다 활발` });
    } else if (volRatio < 0.7) {
      signals.push({ tone: "flat", label: "거래량", text: `20일 평균의 ${volRatio.toFixed(1)}배 — 한산한 편` });
    } else {
      signals.push({ tone: "flat", label: "거래량", text: `20일 평균의 ${volRatio.toFixed(1)}배 — 보통 수준` });
    }
  }
  if (closes.length >= 6 && closes[closes.length - 6] && volumes.length >= 20) {
    const chg5 = (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100;
    const vol20Avg = sma(volumes, 20);
    const vr5 = vol20Avg ? (sma(volumes, 5) ?? 0) / vol20Avg : null;
    if (vr5 != null) {
      const chg5Txt = `${chg5 >= 0 ? "+" : ""}${chg5.toFixed(0)}`;
      if (chg5 >= 10 && vr5 < 0.8) {
        signals.push({ tone: "down", label: "수급", text: `5일간 ${chg5Txt}% 올랐지만 거래량은 감소 — 거래량 없는 상승, 펌핑 유의` });
        score -= 1;
      } else if (chg5 >= 10 && vr5 >= 1.3) {
        signals.push({ tone: "up", label: "수급", text: `5일간 ${chg5Txt}% 상승에 거래량 증가 동반 — 수급이 뒷받침됨` });
        score += 1;
      } else if (chg5 <= -10 && vr5 >= 1.3) {
        signals.push({ tone: "down", label: "수급", text: `5일간 ${chg5Txt}% 하락에 거래량 증가 — 매도 압력이 큼` });
        score -= 1;
      }
    }
  }
  if (volatility != null && volatility >= 6) {
    signals.push({ tone: "down", label: "변동성", text: `최근 20일 일평균 ±${volatility.toFixed(1)}% — 변동성이 매우 큼` });
  }

  let summary: string;
  if (score >= 2) summary = "단기 기술 지표가 대체로 긍정적입니다.";
  else if (score <= -2) summary = "단기 기술 지표가 대체로 부정적입니다.";
  else if (score > 0) summary = "기술 지표가 약간 긍정적이나 확신하기는 이릅니다.";
  else if (score < 0) summary = "기술 지표가 약간 부정적입니다.";
  else summary = "기술 지표가 혼조세로, 뚜렷한 방향성이 없습니다.";

  return {
    summary,
    signals,
    indicators: {
      price, sma20, sma50, rsi14,
      high52: hi52, low52: lo52, pos52,
      vol_ratio: volRatio, volatility20: volatility,
      macd_text: macdText,
      macd_hist: m ? m.hist : null,
      bb_pctb: bb ? bb.pctb : null,
      bb_width: bb ? bb.width : null,
    },
  };
}
