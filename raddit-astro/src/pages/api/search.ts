import type { APIRoute } from "astro";
import { getSearch } from "@/lib/services";
import { errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query || query.length > 40) return jsonError("검색어가 잘못됐습니다.", 400);
  try {
    return jsonCached(await getSearch(query), 600, 1200);
  } catch (exc) {
    return jsonError(`검색 실패: ${errMsg(exc)}`, 502);
  }
};
