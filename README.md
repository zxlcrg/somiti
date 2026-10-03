# Somiti

Savings and loan management for cooperative somitis: members, savings, loans,
double-entry accounting and year-end, for one somiti first and many later.

The design is in the architecture review (Claude Docs: "Somiti Architecture
Review"). This repository follows its milestones; this is M1, the foundation
and ledger core.

## How the money side works

Every money event is one balanced journal entry. Balances and reports are
computed from journal lines and never edited by hand.

| Rule | Where it is enforced |
| --- | --- |
| Debits equal credits, at least two lines | Deferred constraint trigger at commit, plus the service |
| Each line is one positive debit or credit, in paisa (`bigint`) | `CHECK` constraint |
| Posted entries never change | No `UPDATE`/`DELETE` grant for the app; a trigger blocks them even for the owner |
| Lines can't be added to an entry later | Trigger compares the entry's creating transaction |
| Mistakes are fixed by a reversal, at most once per entry | `reverses_id` with a unique index |
| No posting on a closed day, after the business date, or outside an open fiscal year | `BEFORE INSERT` trigger on `journal_entry` |
| Closed days and periods stay closed | Triggers on `tenant` and `fiscal_period` |
| A retried or double-synced request posts once | `idempotency_key` table, keyed per somiti |
| One somiti never sees another's rows | Postgres row-level security on every table, forced for the owner too |

The app connects as `somiti_app`, which owns nothing and cannot bypass RLS.
Migrations run as `somiti_owner`. App code reaches the database only through
`withTenant()` in `src/db/client.ts`, which sets the tenant for one
transaction. ESLint blocks bare `pg` imports and writes to journal tables
outside `src/modules/ledger`.

## Language

English is the default and Bangla is one click away. Strings live in
`messages/en.json` and `messages/bn.json`; CI fails when they drift apart.
Amounts use lakh/crore grouping in both languages and Bangla digits in Bangla
(`src/lib/format.ts`), and amount inputs accept either script
(`parseTaka` in `src/lib/money.ts`). Tenant data such as account names is
stored as `name_en` and `name_bn`, with Bangla collation for sorting.

## Running it

Needs Node 22, pnpm and Postgres 16.

```sh
pnpm install
docker compose up -d db          # Postgres with the two roles (docker/postgres/init.sql)
cp .env.example .env
pnpm db:migrate                  # as somiti_owner
pnpm db:seed                     # optional: a demo somiti with a few entries
pnpm dev
```

Or run everything with `docker compose up --build` (set `AUTH_SECRET`,
`MEMBER_DATA_KEY` and `SMS_CONSOLE=1` in `.env` first; the container runs in
production mode).

## Signing in

Staff and members sign in with their somiti code and mobile number, then a
six-digit code sent by SMS. There is no password.

- Until the SMS gateway arrives (M2), codes are printed in the terminal running
  `pnpm dev` and, in development only, in the browser console. After
  `pnpm db:seed`, sign in at `/sign-in` with somiti code `demo` and mobile
  `01700-000000`.
- A code lasts 5 minutes and locks after 5 wrong tries. A new code can be sent
  once a minute, at most 5 an hour. Only an HMAC of each code is stored.
- The answer never reveals whether a number is registered.
- The session cookie is httpOnly and holds a random token; the database keeps
  only its SHA-256. Sessions last 30 days, end at sign-out, and stop working
  when the user is deactivated.
- Before sign-in there is no tenant, so a narrow policy (`tenant_by_slug` in
  `drizzle/0003`) lets the app see only the somiti whose exact code was typed.
- All expiry and cooldown checks use the database clock.

Code: `src/modules/auth/`, pages in `src/app/sign-in/` and `src/app/dashboard/`,
tests in `tests/auth.test.ts`.

## Members

`/members` lists the somiti's members, `/members/new` admits one and
`/members/<id>` shows the record. The secretary, president and admin can admit;
other staff can look members up.

- Each somiti numbers its members from 1, with no gaps; simultaneous
  admissions take turns for the next number.
- Names are kept in English and Bangla, plus the father's or husband's name in
  both. At least one script is required. Search matches part of a name in
  either script (pg_trgm), a member number or part of a phone number, and
  Bangla lists sort with the `bn-x-icu` collation.
- The NID is encrypted with AES-256-GCM (`MEMBER_DATA_KEY`). A keyed hash
  refuses a duplicate NID within a somiti, and screens only ever show the last
  four digits.
- Each member has a communication language for SMS and receipts, separate
  from the staff member's screen language.
- Members are never deleted: exit and death are statuses. `member_no` and the
  admission record can't be changed, and every admission is in the audit log.
- `journal_line.member_id` now points at a real member.

### Nominees

Who receives a member's savings if the member dies, on the member's page and
at `/members/<id>/nominees`.

- Each nominee has a name in either script, a relationship, a share and,
  optionally, phone, NID (encrypted like members') and date of birth. A
  nominee under 18 needs a guardian.
- Shares are basis points (10000 = 100%). A member's active shares total
  exactly 100% or 0%. The app checks this, and a deferred constraint trigger
  (`drizzle/0007`, SQLSTATE SM008) enforces it at commit.
- Nominees are saved as one set: the previous set is marked removed, never
  deleted or edited (SM009, and no UPDATE grant beyond `removed_at`/`removed_by`),
  so earlier nominations stay on record. A kept nominee keeps its NID
  without retyping it, and saving the same set again changes nothing. Every
  change is in the audit log, without NIDs.
- Only the roles that admit members can change nominees, and only while the
  member is active.

Photos, share purchase and exit come next. Code: `src/modules/members/`, pages
in `src/app/members/`, tests in `tests/members.test.ts` and `tests/nominees.test.ts`.

Tests need a Postgres superuser to create the `somiti_test` database
(defaults to `postgres:postgres@localhost`; override with `TEST_ADMIN_URL`):

```sh
pnpm test
```

## Layout

```
drizzle/                     migrations (0001 holds triggers, RLS and grants)
messages/                    en and bn UI strings
src/db/                      schema, withTenant, migration runner
src/modules/ledger/          posting service, reversals, periods, trial balance, default chart
src/modules/tenancy/         new somiti setup
src/modules/auth/            SMS-code sign-in and sessions
src/modules/members/         admission, KYC, search, nominees
src/modules/audit/           append-only audit log
src/lib/                     money, rounding, digits, dates, formatting
tests/                       ledger invariants, RLS isolation, sign-in, members, nominees, money and i18n
```

## Still to check with an accountant (M0)

- The default chart of accounts and its Bangla names (`src/modules/ledger/default-chart.ts`).
- The rounding rule: half away from zero (`mulDivRound` in `src/lib/money.ts`).
