import type { APIRoute } from "astro";
import { TtlCache } from "@/lib/cache";

// GitHub star 수 — 10분 캐시 (rate limit 60/h 무인증 방지)
const starCache = new TtlCache<{ stars: number; repoUrl: string }>(600_000, 600_000);
const REPO_API = "https://api.github.com/repos/qkrehgus714/raddit";
const REPO_URL = "https://github.com/qkrehgus714/raddit";

export const GET: APIRoute = async () => {
  try {
    const data = await starCache.getOrCompute("repo-info", async () => {
      const res = await fetch(REPO_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "raddit-astro" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const repo = await res.json();
      return { stars: repo.stargazers_count ?? 0, repoUrl: REPO_URL };
    });
    return Response.json(data, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch {
    // 실패 시 fallback — 별 수 0, URL만 반환
    return Response.json({ stars: 0, repoUrl: REPO_URL }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
};
