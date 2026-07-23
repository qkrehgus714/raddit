/**
 * HTTP 응답 헬퍼 — Next.js NextResponse 대신 Web API Response 사용.
 */

/** CDN 캐시 헤더와 함께 JSON 응답. */
export function jsonCached(payload: unknown, sMaxage: number, swr: number): Response {
  return Response.json(payload, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=0, s-maxage=${sMaxage}, stale-while-revalidate=${swr}`,
    },
  });
}

/** 오류 응답은 캐시하지 않는다. */
export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function errMsg(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

export const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;
