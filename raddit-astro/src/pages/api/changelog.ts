import type { APIRoute } from "astro";
import { jsonCached, jsonError, errMsg } from "@/lib/respond";
import { TtlCache } from "@/lib/cache";

const RELEASES_URL = "https://api.github.com/repos/qkrehgus714/raddit/releases?per_page=20";

interface Release {
  tag: string;
  name: string;
  publishedAt: string;
  body: string;
}

// 인메모리 TTL 캐시 — GitHub API rate limit (60/h 무인증) 방지
const releasesCache = new TtlCache<Release[]>(600_000, 600_000);

async function fetchReleases(): Promise<Release[]> {
  return releasesCache.getOrCompute("releases", async () => {
    const res = await fetch(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "raddit-astro",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub Releases 조회 실패: ${res.status}`);
    }
    const raw = await res.json();
    return (Array.isArray(raw) ? raw : []).map((r: any) => ({
      tag: r.tag_name ?? "",
      name: r.name ?? r.tag_name ?? "",
      publishedAt: r.published_at ?? "",
      body: r.body ?? "",
    }));
  });
}

export const GET: APIRoute = async () => {
  try {
    const releases = await fetchReleases();
    return jsonCached(releases, 600, 1200);
  } catch (exc) {
    const msg = errMsg(exc);
    const status = msg.includes("403") || msg.includes("429") ? 429 : 502;
    return jsonError(`변경이력 조회 실패: ${msg}`, status);
  }
};
