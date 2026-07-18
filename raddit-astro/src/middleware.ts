/**
 * Astro node standalone에는 서버 부팅 훅이 없어, 첫 요청에서 급등
 * 감시 폴러를 기동한다 (#74). ensureSpikeWatch는 멱등 — 요청마다
 * 불러도 폴러는 1개.
 */
import { defineMiddleware } from "astro:middleware";
import { ensureSpikeWatch } from "@/lib/spike";

export const onRequest = defineMiddleware((_ctx, next) => {
  ensureSpikeWatch();
  return next();
});
