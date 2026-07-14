import type { APIRoute } from "astro";
import { getPosts } from "@/lib/services";
import { TICKER_RE, errMsg, jsonCached, jsonError } from "@/lib/respond";

export const GET: APIRoute = async ({ url }) => {
  const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase();
  if (!TICKER_RE.test(ticker)) return jsonError("잘못된 티커입니다.", 400);
  try {
    const payload = await getPosts(ticker);
    const ttl = payload.reddit_error || payload.news_error || payload.st_error ? 60 : 600;
    return jsonCached(payload, ttl, ttl);
  } catch (exc) {
    return jsonError(`게시물·뉴스 수집 실패: ${errMsg(exc)}`, 502);
  }
};
