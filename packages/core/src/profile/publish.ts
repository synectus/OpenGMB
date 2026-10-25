import { guardrailSubject, type GuardrailPassed } from "../guardrails";
import type { GoogleAttributes, GoogleLocation } from "../google/client";
import type { ThrottledGoogleClient } from "../google/throttled-client";
import { attributesBody, locationPatch, type ProfileValues } from "./fields";
import { profileGuardrailContext } from "./guardrails";

/**
 * The ONLY place outside the Google client implementations that writes a location profile or its
 * attributes to Google. A test (`reply-enforcement.test.ts`) fails if any other source file calls
 * `.updateLocation(` or `.updateAttributes(`. Both writes take a `GuardrailPassed` and check that it
 * was issued for EXACTLY the values being sent, so a field changed after the check cannot ride on
 * an earlier pass. The masks are minimal (only changed fields) and come from the stored diff.
 */
export type ProfileWriter = Pick<
  ThrottledGoogleClient,
  "getLocation" | "getAttributes" | "updateLocation" | "updateAttributes"
>;

/** Idempotency key for the location part of one change set at one location. */
export const profileKey = (changeSetId: string, locationId: string) =>
  `profile:${changeSetId}:${locationId}`;
/** Idempotency key for the attributes part (a separate Google call, so a separate key). */
export const profileAttributesKey = (changeSetId: string, locationId: string) =>
  `profile:${changeSetId}:${locationId}:attributes`;

function assertIssuedFor(after: ProfileValues, passed: GuardrailPassed) {
  const subject = guardrailSubject(profileGuardrailContext(after, { name: "", phone: null }));
  if (passed.reply !== subject) {
    throw new Error("Profile values differ from the values that passed the guardrails");
  }
}

export const subjectOf = (after: ProfileValues) =>
  guardrailSubject(profileGuardrailContext(after, { name: "", phone: null }));

type Where = { orgId: string; changeSetId: string; locationId: string; locationName: string };

/** locations.patch with the minimal updateMask. */
export function publishProfileFields(
  client: ProfileWriter,
  p: Where,
  after: ProfileValues,
  updateMask: string[],
  passed: GuardrailPassed,
): Promise<GoogleLocation> {
  assertIssuedFor(after, passed);
  return client.updateLocation(p.locationName, locationPatch(after), updateMask, {
    orgId: p.orgId,
    idempotencyKey: profileKey(p.changeSetId, p.locationId),
  });
}

/** locations.updateAttributes with the minimal attributeMask. */
export function publishProfileAttributes(
  client: ProfileWriter,
  p: Where,
  after: ProfileValues,
  attributeMask: string[],
  passed: GuardrailPassed,
): Promise<GoogleAttributes> {
  assertIssuedFor(after, passed);
  return client.updateAttributes(
    p.locationName,
    attributesBody(`${p.locationName}/attributes`, after),
    attributeMask,
    { orgId: p.orgId, idempotencyKey: profileAttributesKey(p.changeSetId, p.locationId) },
  );
}
