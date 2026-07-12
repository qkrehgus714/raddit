import type { APIRoute } from "astro";
import { jsonCached } from "@/lib/respond";
import pkg from "../../../package.json";

export const GET: APIRoute = async () => {
  return jsonCached({ version: pkg.version ?? "0.0.0" }, 300, 600);
};
