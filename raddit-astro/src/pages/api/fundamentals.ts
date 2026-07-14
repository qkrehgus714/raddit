import type { APIRoute } from "astro";
import { getFundamentals } from "@/lib/services";
import { TICKER_RE, errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase();
  if (!TICKER_RE.test(ticker)) return jsonError("잘못된 티커입니다.", 400);
  try {
    const payload = await getFundamentals(ticker);
    const ttl = payload.error ? 60 : 600;
    return jsonCached(payload, ttl, ttl);
  } catch (exc) {
    return jsonError(`재무/공시 수집 실패: ${errMsg(exc)}`, 502);
  }
};
