import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // 프런트엔드는 검증된 기존 대시보드(정적 파일)를 그대로 사용 — API 경로가 동일해 무수정 호환
    return [{ source: "/", destination: "/dashboard.html" }];
  },
};

export default nextConfig;
