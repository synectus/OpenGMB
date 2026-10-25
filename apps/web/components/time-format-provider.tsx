"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { makeTimeFormat, type TimeFormat, type TimeFormatData } from "../lib/time-format";

const Ctx = createContext<TimeFormat | null>(null);

/** Gives client components the same formatter the server uses (see lib/time-format.ts). */
export function TimeFormatProvider({ data, children }: { data: TimeFormatData; children: ReactNode }) {
  const tf = useMemo(() => makeTimeFormat(data), [data]);
  return <Ctx.Provider value={tf}>{children}</Ctx.Provider>;
}

export function useTimeFormat(): TimeFormat {
  const tf = useContext(Ctx);
  if (!tf) throw new Error("useTimeFormat needs <TimeFormatProvider> (it is in the app layout)");
  return tf;
}
