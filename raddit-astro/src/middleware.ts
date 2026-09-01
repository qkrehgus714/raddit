/**
 * Astro node standalone에는 서버 부팅 훅이 없어, 첫 요청에서 백그라운드
 * 작업들을 기동한다. 둘 다 멱등 — 요청마다 불러도 각각 1개만 돈다.
 *
 * - ensureSpikeWatch     급등 감시 폴러 (#74, 90초)
 * - ensureHistoryCollect 언급·시세 이력 수집 (#112, 1시간)
 */
import { defineMiddleware } from "astro:middleware";
import { ensureSpikeWatch } from "@/lib/spike";
import { ensureHistoryCollect } from "@/lib/history";

export const onRequest = defineMiddleware((_ctx, next) => {
  ensureSpikeWatch();
  ensureHistoryCollect();
  return next();
});
