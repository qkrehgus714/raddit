import type { APIRoute } from "astro";
import { getData } from "@/lib/services";
import { errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const sp = url.searchParams;
  const market = sp.get("market") === "crypto" ? "crypto" : "stocks";
  const filter = sp.get("filter") ?? (market === "crypto" ? "all-crypto" : "all-stocks");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(filter)) {
    return jsonError("잘못된 필터 이름입니다.", 400);
  }
  const maxPrice = Number(sp.get("max_price") ?? "5");
  const minMentions = Number(sp.get("min_mentions") ?? "2");
  if (!Number.isFinite(maxPrice) || !Number.isInteger(minMentions) || maxPrice < 0 || minMentions < 0) {
    return jsonError("숫자 파라미터가 잘못됐습니다.", 400);
  }
  try {
    return jsonCached(await getData(filter, maxPrice, minMentions, market), 120, 240);
  } catch (exc) {
    return jsonError(`데이터 수집 실패: ${errMsg(exc)}`, 502);
  }
};
