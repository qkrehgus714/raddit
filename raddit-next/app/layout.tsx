import type { ReactNode } from "react";

export const metadata = {
  title: "레딧 페니주식 워치보드",
  description: "레딧 주식 서브레딧 언급량 기반 페니주식 스크리너",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
