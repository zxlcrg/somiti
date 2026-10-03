/** Test database connection strings. CI and local runs use the same defaults. */
const host = process.env.TEST_PG_HOST ?? "localhost";
const port = process.env.TEST_PG_PORT ?? "5432";
export const TEST_DB = "somiti_test";

export const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? `postgres://postgres:postgres@${host}:${port}/postgres`;
export const OWNER_URL = `postgres://somiti_owner:somiti_owner_dev@${host}:${port}/${TEST_DB}`;
export const APP_URL = `postgres://somiti_app:somiti_app_dev@${host}:${port}/${TEST_DB}`;
