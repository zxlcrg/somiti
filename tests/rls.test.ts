import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db/client";
import { otpChallenge, userSession } from "../src/db/schema";
import { admitMember, buyShares, saveNominees, setMemberPhoto } from "../src/modules/members";
import { postEntry, reverseEntry, submitVoucher } from "../src/modules/ledger";
import { app, deposit, newTenant, owner, type TestTenant } from "./helpers";

/**
 * Tenant isolation. The table list is read from the database, so a table
 * added by a later migration is covered without touching this file.
 */

async function tenantTables(): Promise<string[]> {
  const res = await owner.pool.query<{ table_name: string }>(`
    select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'tenant_id'
     order by table_name`);
  return res.rows.map((r) => r.table_name);
}

let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  a = await newTenant();
  b = await newTenant();
  for (const t of [a, b]) {
    const posted = await t.run((ctx) => postEntry(ctx, deposit(t, 1_000n, { idempotencyKey: `seed-${t.tenantId}` })));
    await t.run((ctx) => reverseEntry(ctx, { entryId: posted.entry.id, reason: "seed", createdBy: t.adminUserId }));
    await t.run(async ({ tx, tenantId }) => {
      const later = sql`now() + interval '1 day'`;
      await tx.insert(otpChallenge).values({ tenantId, userId: t.adminUserId, codeHash: "seed", expiresAt: later });
      await tx.insert(userSession).values({ tenantId, userId: t.adminUserId, tokenHash: `seed-${tenantId}`, expiresAt: later });
    });
    await t.run(async (ctx) => {
      const admitted = await admitMember(ctx, { nameEn: "Seed member", phone: "01711111111" }, { userId: t.adminUserId });
      if (!admitted.ok) throw new Error("seed member");
      await saveNominees(ctx, admitted.member.id, [{ nameEn: "Seed nominee", relation: "spouse", share: "100" }], {
        userId: t.adminUserId,
      });
      await setMemberPhoto(ctx, admitted.member.id, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
        userId: t.adminUserId,
      });
      await buyShares(
        ctx,
        { memberId: admitted.member.id, shares: 1, method: "cash", idempotencyKey: `seed-shares-${t.tenantId}` },
        { userId: t.adminUserId },
      );
      const v = await submitVoucher(ctx, {
        branchId: t.branchId,
        createdBy: t.adminUserId,
        narration: "Seed voucher",
        lines: [
          { accountId: t.accounts.bank, debit: "10", credit: "" },
          { accountId: t.accounts.cash_in_hand, debit: "", credit: "10" },
        ],
      });
      if (!v.ok) throw new Error("seed voucher");
    });
  }
});

describe("row-level security", () => {
  it("is enabled and forced, with a policy, on every table that has tenant_id", async () => {
    const tables = [...(await tenantTables()), "tenant"];
    expect(tables.length).toBeGreaterThanOrEqual(11);
    const res = await owner.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1)`,
      [tables],
    );
    expect(res.rows).toHaveLength(tables.length);
    for (const row of res.rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(row.policies, row.relname).toBeGreaterThan(0);
    }
  });

  it("connects the app as a role that cannot bypass RLS and owns nothing", async () => {
    const role = await app.pool.query(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await app.pool.query(
      "select count(*)::int as n from pg_class where relowner = (select oid from pg_roles where rolname = current_user)",
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it("shows tenant A none of tenant B's rows, on every table", async () => {
    const tables = await tenantTables();
    for (const table of tables) {
      const own = await a.run(({ tx }) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`),
      );
      const other = await a.run(({ tx }) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${b.tenantId}`,
        ),
      );
      expect(own.rows[0]!.n, `${table}: tenant A sees its own rows`).toBeGreaterThan(0);
      expect(other.rows[0]!.n, `${table}: tenant A sees tenant B`).toBe(0);
    }
    const tenants = await a.run(({ tx }) => tx.execute<{ id: string }>(sql`select id from tenant`));
    expect(tenants.rows.map((r) => r.id)).toEqual([a.tenantId]);
  });

  it("shows nothing at all when no tenant is set", async () => {
    for (const table of [...(await tenantTables()), "tenant"]) {
      const res = await app.pool.query(`select count(*)::int as n from ${table}`);
      expect(res.rows[0].n, table).toBe(0);
    }
  });

  it("refuses writes into another tenant", async () => {
    const err = await a
      .run(({ tx }) =>
        tx.execute(sql`insert into branch (tenant_id, code, name_en) values (${b.tenantId}, 'X', 'Intruder')`),
      )
      .catch((e: unknown) => e);
    expect(String((err as { cause?: Error }).cause?.message ?? err)).toMatch(/row-level security/);
  });

  it("refuses to post into tenant B using tenant B's accounts from tenant A's session", async () => {
    const err = await a
      .run((ctx) =>
        postEntry(ctx, {
          ...deposit(b, 100n),
          branchId: a.branchId,
          createdBy: a.adminUserId,
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ACCOUNT_NOT_POSTABLE" });
  });

  it("cannot update or delete another tenant's rows", async () => {
    const res = await a.run(({ tx }) =>
      tx.execute(sql`update branch set name_en = 'Hijacked' where tenant_id = ${b.tenantId}`),
    );
    expect(res.rowCount).toBe(0);
    const check = await b.run(({ tx }) => tx.execute<{ name_en: string }>(sql`select name_en from branch`));
    expect(check.rows.map((r) => r.name_en)).toEqual(["Main"]);
  });

  it("rejects a malformed tenant id before touching the database", async () => {
    await expect(withTenant(app.db, "'; drop table tenant; --", async () => 1)).rejects.toThrow(/Invalid tenant id/);
  });
});
