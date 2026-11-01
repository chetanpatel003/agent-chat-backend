import type { NextConfig } from "next";

// API-only app: route handlers are always dynamic, so no component caching.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pino", "pg"],
};

export default nextConfig;
