/// <reference types="vitest" />
// Astro 통합(경로 별칭 "@/*", Solid JSX 등)을 그대로 재사용해 유닛 테스트에서도
// API 라우트(@/lib/* import)와 SolidJS 컴포넌트를 문제없이 import 할 수 있게 한다.
import { getViteConfig } from "astro/config";

export default getViteConfig({});