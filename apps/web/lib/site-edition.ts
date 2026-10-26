import type { NextRequest, NextResponse } from "next/server";

/** Community edition: no extra public pages, and only location pages may be indexed. */
export const shouldNoindex = (pathname: string): boolean => !/^\/l\/[a-z0-9][a-z0-9-]{1,59}$/.test(pathname);

export const isHostedPublicPath = (_pathname: string): boolean => false;

export const isProductSitePath = (_pathname: string): boolean => false;

/** Community edition: no staging gate. */
export const stagingGate = (_request: NextRequest): NextResponse | null => null;

/** Community edition: no payment checkout, so the Content-Security-Policy adds no hosts. */
export const CSP_EXTRA_HOSTS: { connect: string[]; frame: string[]; img: string[] } = { connect: [], frame: [], img: [] };
