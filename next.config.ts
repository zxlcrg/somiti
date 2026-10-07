import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  // Stop `next dev` from writing AGENTS.md and CLAUDE.md into the repo root.
  agentRules: false,
  // The opening-balance sheet (up to 1 MB, and Bangla text takes three bytes a letter) is posted twice: to preview, then to import.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
};

export default withNextIntl(nextConfig);
