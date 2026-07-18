import type { APIRoute } from "astro";
import { getHype } from "@/lib/services";
import { errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const sp = url.searchParams;
  const marketParam = sp.get("market");
  // 누락은 stocks 기본값, 명시된 값은 stocks/crypto만 허용 — 그 외 400
  if (marketParam != null && marketParam !== "stocks" && marketParam !== "crypto") {
    return jsonError("market는 stocks 또는 crypto만 허용됩니다.", 400);
  }
  const market = marketParam === "crypto" ? "crypto" : "stocks";
  const filter = sp.get("filter") ?? (market === "crypto" ? "all-crypto" : "all-stocks");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(filter)) {
    return jsonError("잘못된 필터 이름입니다.", 400);
  }
  try {
    return jsonCached(await getHype(filter, market), 120, 240);
  } catch (exc) {
    return jsonError(`Hype 데이터 수집 실패: ${errMsg(exc)}`, 502);
  }
};
