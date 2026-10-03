import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { translateDbError } from "@/modules/ledger/errors";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A transaction that runs as one somiti. Every module function takes one of these. */
export interface TenantTx {
  readonly tx: Tx;
  readonly tenantId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * The only way app code reaches the database. Opens a transaction, sets the
 * tenant for row-level security with SET LOCAL semantics, and runs `fn`.
 * The setting ends with the transaction, so it never leaks to the next
 * user of a pooled connection.
 *
 * Database rule violations (unbalanced entry, closed day, ...) are rethrown
 * as LedgerError. Some are only detected at commit, which is why the
 * mapping happens here rather than in the ledger service.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (ctx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error(`Invalid tenant id: ${tenantId}`);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn({ tx, tenantId });
    });
  } catch (err) {
    throw translateDbError(err) ?? err;
  }
}

let appDb: Db | undefined;

/** The app's shared pool, connected as the non-owner somiti_app role. */
export function getAppDb(): Db {
  if (!appDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    appDb = createDb(url).db;
  }
  return appDb;
}
