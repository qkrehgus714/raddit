import type { APIRoute } from "astro";
import { getAlerts } from "@/lib/spike";

// 인메모리 이력 직렬화 — 항상 최신을 줘야 하므로 캐시하지 않는다
export const GET: APIRoute = async () =>
  Response.json(getAlerts(), { headers: { "Cache-Control": "no-store" } });
