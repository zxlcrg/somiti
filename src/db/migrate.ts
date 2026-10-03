import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

/** Applies drizzle/ migrations as the owner role. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const { db, pool } = createDb(ownerUrl);
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error("DATABASE_OWNER_URL is not set");
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log("Migrations applied."),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
