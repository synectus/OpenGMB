// One wording for "approved, not on Google yet", shared by Home and the location Overview.
// The count comes from core's reply stage (waiting_publish); this only words it.

/** "2 approved replies are waiting to publish" plus, when writes are off, why nothing is sent. */
export function waitingToPublishText(n: number, writesOff: boolean): string {
  const what = n === 1 ? "1 approved reply is" : `${n} approved replies are`;
  return `${what} waiting to publish.${writesOff ? " Google writes are off on this server, so nothing is sent to Google." : ""}`;
}
