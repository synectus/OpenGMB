/** Community edition: no billing. Same names as the full module; every check allows and nothing is charged. */
import type { Tx } from "@opengmb/db";
import { AccessError, type Actor } from "../actor";
import { CoreError } from "../errors";

type Env = Record<string, string | undefined>;

export const billingMode = (_env?: Env): "off" | "hosted" => "off";

export class CreditExhaustedError extends CoreError {
  constructor(public readonly needMicro: number, public readonly availableMicro: number) {
    super("FORBIDDEN", "Not enough credit");
  }
}

export async function assertWritable(_tx: Tx, _actor: unknown, _actionName: string, _now: Date, _env?: Env): Promise<void> {}

export async function assertCredit(_tx: Tx, _orgId: string, _needMicro: number, _now: Date, _env?: Env): Promise<void> {}

export async function debit(
  _tx: Tx,
  _p: { orgId: string; reason: "ai" | "scan"; refId: string; microUsd: number; now: Date; env?: Env },
): Promise<{ allocatedMicro: number; shortfallMicro: number }> {
  return { allocatedMicro: 0, shortfallMicro: 0 };
}

export const withMarkupMicro = (rawMicro: number): number => rawMicro;

export const meteredMarkupPercent = (_env?: Env): number | null => null;

export async function isReadOnlyAccount(_tx: Tx, _orgId: string, _now: Date, _env?: Env): Promise<boolean> {
  return false;
}

/** Settings that switch AI on or off are changed by a signed-in person, never by an API token. */
export function assertHumanBillingCaller(actor: Pick<Actor, "actorType">): void {
  if (actor.actorType === "api_token") throw new AccessError("FORBIDDEN", "API tokens cannot change this setting");
}
