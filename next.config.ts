import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pipeline runs (discover/enrich) can exceed the default body/time limits of
  // static optimization; everything under /api is dynamic by nature.
  experimental: {},
};

export default nextConfig;
