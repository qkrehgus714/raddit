import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET } from "./data";
import { getData } from "@/lib/services";

// /api/data (#93) — market 쿼리 파라미터 파싱·기본값·유효성 검사.
// getData 자체(비즈니스 로직)는 services.test.ts 에서 검증하므로 여기서는 mock 처리.
vi.mock("@/lib/services", () => ({ getData: vi.fn() }));

const mkCtx = (query = "") => ({ url: new URL(`http://localhost/api/data${query}`) }) as any;

const samplePayload = {
  generated_at: "2026-07-18 00:00:00",
  filter: "all-stocks",
  max_price: 5,
  scanned: 0,
  items: [],
};

describe("GET /api/data", () => {
  beforeEach(() => {
    vi.mocked(getData).mockReset();
    vi.mocked(getData).mockResolvedValue(samplePayload as any);
  });

  it("market 파라미터가 없으면 stocks + all-stocks 기본값을 사용한다", async () => {
    const res = await GET(mkCtx());

    expect(getData).toHaveBeenCalledWith("all-stocks", 5, 2, "stocks");
    expect(res.status).toBe(200);
  });

  it("market=crypto 이고 filter가 없으면 all-crypto 기본값을 사용한다", async () => {
    await GET(mkCtx("?market=crypto"));

    expect(getData).toHaveBeenCalledWith("all-crypto", 5, 2, "crypto");
  });

  it("market=crypto + filter + max_price=0 조합을 그대로 getData에 전달한다", async () => {
    await GET(mkCtx("?market=crypto&filter=Bitcoin&max_price=0"));

    expect(getData).toHaveBeenCalledWith("Bitcoin", 0, 2, "crypto");
  });

  it("market 값이 정확히 'crypto'가 아니면 stocks로 취급한다 (대소문자 등)", async () => {
    await GET(mkCtx("?market=Crypto"));

    expect(getData).toHaveBeenCalledWith("all-stocks", 5, 2, "stocks");
  });

  it("잘못된 필터 이름 형식이면 400을 반환하고 getData를 호출하지 않는다", async () => {
    const res = await GET(mkCtx("?filter=bad_filter!"));

    expect(res.status).toBe(400);
    expect(getData).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe("잘못된 필터 이름입니다.");
  });

  it("filter가 빈 문자열이면 400을 반환한다", async () => {
    const res = await GET(mkCtx("?filter="));

    expect(res.status).toBe(400);
    expect(getData).not.toHaveBeenCalled();
  });

  it("min_mentions이 정수가 아니면 400을 반환한다", async () => {
    const res = await GET(mkCtx("?min_mentions=1.5"));

    expect(res.status).toBe(400);
    expect(getData).not.toHaveBeenCalled();
  });

  it("max_price가 음수면 400을 반환한다", async () => {
    const res = await GET(mkCtx("?max_price=-1"));

    expect(res.status).toBe(400);
  });

  it("getData 실패 시 502와 오류 메시지를 반환한다", async () => {
    vi.mocked(getData).mockRejectedValueOnce(new Error("Yahoo 레이트리밋"));

    const res = await GET(mkCtx());

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("데이터 수집 실패: Yahoo 레이트리밋");
  });

  it("성공 응답에는 CDN 캐시 헤더가 포함된다", async () => {
    const res = await GET(mkCtx());

    expect(res.headers.get("Cache-Control")).toContain("s-maxage=120");
  });
});