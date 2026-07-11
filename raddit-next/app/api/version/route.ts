import pkg from "@/package.json";
import { jsonCached } from "@/lib/respond";

/** GET /api/version → { version } */
export async function GET() {
  return jsonCached(
    { version: pkg.version ?? "0.0.0" },
    300,
    600,
  );
}
