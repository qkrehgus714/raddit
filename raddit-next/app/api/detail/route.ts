import { NextRequest } from "next/server";
import { RANGE_SPEC } from "@/lib/indicators";
import { detailTtlSec, getDetail } from "@/lib/services";
import { TICKER_RE, errMsg, jsonCached, jsonError } from "@/lib/respond";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") ?? "").toUpperCase();
  const rng = sp.get("range") ?? "min";
  if (!TICKER_RE.test(ticker)) return jsonError("잘못된 티커입니다.", 400);
  if (!(rng in RANGE_SPEC)) return jsonError("잘못된 차트 범위입니다.", 400);
  try {
    const ttl = detailTtlSec(rng);
    return jsonCached(await getDetail(ticker, rng), ttl, ttl);
  } catch (exc) {
    return jsonError(`차트 데이터 수집 실패: ${errMsg(exc)}`, 502);
  }
}
