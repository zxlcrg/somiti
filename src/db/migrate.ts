import { pathToFileURL } from "node:url";
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

// Run when called as a script. pathToFileURL keeps this working on Windows,
// where argv[1] is "D:\\..." and import.meta.url is "file:///D:/...".
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
