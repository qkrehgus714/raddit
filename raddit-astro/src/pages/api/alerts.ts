import type { APIRoute } from "astro";
import { getAlerts } from "@/lib/spike";
import { peekFinraShortMap } from "@/lib/services";

// 인메모리 이력 직렬화 — 항상 최신을 줘야 하므로 캐시하지 않는다.
// 숏 비중(#76)은 FINRA 공유 캐시 lookup만 — 미로드·해당 티커 없음이면 null.
export const GET: APIRoute = async () => {
  const payload = getAlerts();
  const finra = peekFinraShortMap();
  const alerts = payload.alerts.map(a => ({
    ...a,
    short_vol_pct: finra?.map.get(a.ticker)?.short_vol_pct ?? null,
  }));
  return Response.json({ ...payload, alerts }, { headers: { "Cache-Control": "no-store" } });
};
