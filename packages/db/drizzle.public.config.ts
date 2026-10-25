import { defineConfig } from "drizzle-kit";

// Public (community edition) migration line: shared tables only. The export copies
// oss/packages/db/drizzle over packages/db/drizzle.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/shared.ts",
  out: "../../oss/packages/db/drizzle",
});
