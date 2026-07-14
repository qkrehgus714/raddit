import type { APIRoute } from "astro";
import { getDailySpark } from "@/lib/services";
import { TICKER_RE, errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase();
  if (!TICKER_RE.test(ticker)) return jsonError("잘못된 티커입니다.", 400);
  try {
    const payload = await getDailySpark(ticker);
    return jsonCached(payload, 600, 600);
  } catch (exc) {
    return jsonError(`spark 조회 실패: ${errMsg(exc)}`, 502);
  }
};
