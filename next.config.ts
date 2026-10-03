import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  // Stop `next dev` from writing AGENTS.md and CLAUDE.md into the repo root.
  agentRules: false,
};

export default withNextIntl(nextConfig);
