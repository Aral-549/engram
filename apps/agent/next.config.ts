import type { NextConfig } from "next";

// One codebase, two personas: NEXT_PUBLIC_* values are baked in at build time, so each persona builds into its
// own directory (NEXT_DIST_DIR in .env.assistant / .env.planner).
const config: NextConfig = { reactStrictMode: true, poweredByHeader: false, distDir: process.env.NEXT_DIST_DIR ?? ".next" };
export default config;
