import { existsSync } from "node:fs";
import { runMigrations } from "./migrate";

const envFile = new URL("../../../.env", import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (or pass a URL as the first argument)");
await runMigrations(url);
console.log("migrations applied");
