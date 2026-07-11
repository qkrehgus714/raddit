import { NextResponse } from "next/server";

/**
 * CDN(Vercel Edge) 캐시 헤더 — 캐시 3층 구조의 최상층.
 * s-maxage 동안은 서버리스 함수까지 오지도 않고 엣지에서 응답하고,
 * stale-while-revalidate 구간에는 옛 응답을 즉시 주면서 뒤에서 갱신한다.
 */
export function jsonCached(payload: unknown, sMaxage: number, swr: number): NextResponse {
  return NextResponse.json(payload, {
    headers: { "Cache-Control": `public, max-age=0, s-maxage=${sMaxage}, stale-while-revalidate=${swr}` },
  });
}

/** 오류 응답은 캐시하지 않는다. */
export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function errMsg(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

export const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;
