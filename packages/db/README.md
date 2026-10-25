# @opengmb/db

Drizzle schema, migrations and client.

- `src/schema/shared.ts`: tables that also ship in the community edition.
- `src/schema/private.ts`: hosted-only tables. `src/schema.ts` re-exports both, so importers do not change.
- `drizzle/`: the private migration line. `../../oss/packages/db/drizzle/`: the public line.

Changing a shared table? Run `pnpm db:generate` AND `pnpm db:generate:public`; the drift test (`src/public-schema-drift.test.ts`) fails otherwise. Never edit a published public migration.

A private table must not be referenced from `shared.ts` (`src/schema-split.test.ts` fails if it is).
