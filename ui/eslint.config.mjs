import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "static/.next/**",
    "static/out/**",
    "out/**",
    "build/**",
    "vendor/**",
    "lib/features/crawler/license-data.ts",
    "next-env.d.ts",
    "scripts/temp/**",
  ]),
]);

export default eslintConfig;
