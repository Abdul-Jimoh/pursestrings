import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Type checking runs through `pnpm typecheck` (TypeScript 7), which Next's own checker predates.
  typescript: { ignoreBuildErrors: true },
};

export default config;
