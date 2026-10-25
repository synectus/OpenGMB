import { runMigrations } from "./packages/db/src/migrate";

export default async function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url)
    throw new Error("DATABASE_URL_TEST is not set; refusing to run tests without a test database");
  await runMigrations(url);
}
