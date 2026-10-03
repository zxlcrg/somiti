import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "drizzle/**"] },
  {
    // Only the ledger module writes journal tables, and app code reaches the
    // database only through withTenant (src/db/client.ts).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/modules/ledger/**", "src/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message: "Use withTenant from @/db/client; bare connections skip row-level security.",
            },
            {
              name: "@/db/schema",
              importNames: ["journalEntry", "journalLine", "entryCounter"],
              message: "Only the ledger module writes journal tables. Call postEntry or reverseEntry.",
            },
          ],
          patterns: [
            {
              group: ["@/modules/ledger/*"],
              message: "Import the ledger through @/modules/ledger, its public entry point.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
