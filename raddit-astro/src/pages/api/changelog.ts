import type { APIRoute } from "astro";
import { jsonCached, jsonError, errMsg } from "@/lib/respond";

const RELEASES_URL = "https://api.github.com/repos/qkrehgus714/raddit/releases?per_page=20";

interface Release {
  tag: string;
  name: string;
  publishedAt: string;
  body: string;
}

export const GET: APIRoute = async () => {
  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "raddit-astro",
      },
    });

    if (!res.ok) {
      return jsonError(
        `GitHub Releases 조회 실패: ${res.status}`,
        res.status === 403 || res.status === 429 ? 429 : 502,
      );
    }

    const raw = await res.json();
    const releases: Release[] = (Array.isArray(raw) ? raw : []).map(
      (r: any) => ({
        tag: r.tag_name ?? "",
        name: r.name ?? r.tag_name ?? "",
        publishedAt: r.published_at ?? "",
        body: r.body ?? "",
      }),
    );

    return jsonCached(releases, 600, 1200);
  } catch (exc) {
    return jsonError(`변경이력 조회 실패: ${errMsg(exc)}`, 502);
  }
};
