export type Edition = "hosted" | "community";

export const EDITION = "community" as Edition;

export const isCommunity = (): boolean => EDITION === "community";
