# SBOS pg-port (W113-2 / W116) — operator guide

The pg-port is an **opt-in** backend. The default is still
sqlite. To run on a real pg database:

## 1. Install the `pg` package

The pg adapter lazy-imports the `pg` package; the npm
install is opt-in so the default sqlite path doesn't
require it.

```sh
npm install pg --save
# or, to honour package.json's optionalDependencies:
npm install --include=optional
```

## 2. Bring up a pg instance

The repo ships a docker-compose for local development:

```sh
docker compose -f docker-compose.pg.yml up -d
# Wait for healthcheck: docker compose ps should show "healthy"
```

For production, point `SBOS_PG_URL` at your managed pg
(Supabase, RDS, Cloud SQL, etc.).

## 3. Set the env vars

```sh
export SBOS_DB_BACKEND=postgres
export SBOS_PG_URL=postgres://sbos:sbos@localhost:5432/sbos
```

`SBOS_PG_URL` is the libpq connection string. The
adapter forwards `query()` calls as-is — no SQL
translation needed because pg speaks the same
`$1, $2` placeholder syntax the SBOS pure functions
already emit.

## 4. Run migrations

The migration runner detects the backend from
`SBOS_DB_BACKEND`. On pg, the schema prefixes (`finance.`,
`sbos_rbac.`) are KEPT in the DDL. On sqlite, they're
stripped. The same migration files work for both.

```sh
node bin/sbos-server.mjs
# boots, applies migrations, listens
```

## 5. Run the integration test (opt-in)

```sh
SBOS_PG_URL=postgres://sbos:sbos@localhost:5432/sbos \\
  npm test -- server/db/pgIntegration.test.js
```

The test skips itself when `SBOS_PG_URL` is unset, so
the default `npm test` (sqlite) doesn't fail.

## What works on pg (today)

- Boot path: createApp + startServer.
- W113-2 pgAdapter factory + connection management.
- The pure functions that already speak pg SQL (the
  finance data-quality, retention, audit, merge
  functions).
- Migration runner with the same `.sql` files.

## What does NOT work on pg (today)

- The factory pattern in `server/db/realDb.js` only
  wraps sqlite. A real pg boot path is a follow-up
  slice.
- Some SQL is sqlite-flavoured: `datetime('now')`,
  `strftime`, `IFNULL` vs `COALESCE`, `GROUP_CONCAT`.
  These would need a translation pass for full pg
  coverage.
- The finance migration runner (`server/finance/
  migrate.js`) uses pg-style placeholders but the
  SQLite translation layer strips them. On real pg,
  the strip must be a no-op.
- Performance benchmarks (pg vs sqlite for the
  SBOS workload).

These are tracked in the W113 follow-up. See the
v1.4.20 release notes for what shipped in slice 1.