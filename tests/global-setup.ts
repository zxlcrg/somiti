import pg from "pg";
import { runMigrations } from "../src/db/migrate";
import { ADMIN_URL, OWNER_URL, TEST_DB } from "./env";

/** Creates a fresh test database with the same roles as production and applies all migrations. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'somiti_owner') THEN
          CREATE ROLE somiti_owner LOGIN PASSWORD 'somiti_owner_dev';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'somiti_app') THEN
          CREATE ROLE somiti_app LOGIN PASSWORD 'somiti_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END $$;`);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB} OWNER somiti_owner`);
  } finally {
    await admin.end();
  }

  const adminOnTestDb = new pg.Client({ connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`) });
  await adminOnTestDb.connect();
  try {
    await adminOnTestDb.query("ALTER SCHEMA public OWNER TO somiti_owner");
  } finally {
    await adminOnTestDb.end();
  }

  await runMigrations(OWNER_URL);
}
