import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../../lib/auth";

// Lazy so the module can be evaluated at build time without a database.
export const GET = (req: Request) => toNextJsHandler(getAuth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(getAuth()).POST(req);
