import { reportStartupConfig } from "@opengmb/core";
import { startServer } from "./http";

reportStartupConfig("mcp");

const port = Number(process.env.MCP_PORT ?? 3100);
const { port: bound } = await startServer(port);
console.log(`[mcp] listening on :${bound} (POST /mcp, GET /healthz)`);
