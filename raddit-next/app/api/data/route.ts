import { NextRequest } from "next/server";
import { getData } from "@/lib/services";
import { errMsg, jsonCached, jsonError } from "@/lib/respond";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filter = sp.get("filter") ?? "all-stocks";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(filter)) {
    return jsonError("잘못된 필터 이름입니다.", 400);
  }
  const maxPrice = Number(sp.get("max_price") ?? "5");
  const minMentions = Number(sp.get("min_mentions") ?? "2");
  if (!Number.isFinite(maxPrice) || !Number.isInteger(minMentions)) {
    return jsonError("숫자 파라미터가 잘못됐습니다.", 400);
  }
  try {
    return jsonCached(await getData(filter, maxPrice, minMentions), 120, 240);
  } catch (exc) { // 외부 API 장애를 클라이언트에 그대로 전달
    return jsonError(`데이터 수집 실패: ${errMsg(exc)}`, 502);
  }
}
