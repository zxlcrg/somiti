import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  // Don't write AGENTS.md / CLAUDE.md into the repo on every `next dev`.
  agentRules: false,
};

export default withNextIntl(nextConfig);
