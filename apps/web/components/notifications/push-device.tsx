"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { parseSubscriptionBody, urlBase64ToUint8Array } from "../../lib/push-client";
import { buttonClass, ErrorText, secondaryButtonClass } from "../ui";

type State = "checking" | "unsupported" | "blocked" | "off" | "on";

const ENDPOINT = "/api/push/subscription";

/** Turn alerts on or off for this browser. Opt-in per device: nothing is asked until the button is pressed. */
export function PushDevice({ publicKey }: { publicKey: string }) {
  const t = useTranslations("settingsStatus.notifications.push");
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const supported =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const found: Promise<State> = supported
      ? navigator.serviceWorker
          .register("/sw.js")
          .then((reg) => reg.pushManager.getSubscription())
          .then((sub) => (sub ? "on" : Notification.permission === "denied" ? "blocked" : "off"))
      : Promise.resolve("unsupported");
    found.catch(() => "unsupported" as const).then((next) => live && setState(next));
    return () => {
      live = false;
    };
  }, []);

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const json = sub.toJSON();
      if (!parseSubscriptionBody(json)) throw new Error(t("errUnusable"));
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(json),
      });
      if (!res.ok) {
        await sub.unsubscribe();
        throw new Error(t("errSave"));
      }
      setState("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errOn"));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(ENDPOINT, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errOff"));
    } finally {
      setBusy(false);
    }
  }

  if (state === "checking") return null;
  return (
    <div className="flex flex-col gap-2">
      {state === "unsupported" && (
        <p className="text-sm text-muted-foreground">
          {t("unsupported")}
        </p>
      )}
      {state === "blocked" && (
        <p className="text-sm text-muted-foreground">
          {t("blocked")}
        </p>
      )}
      {state === "off" && (
        <div>
          <button type="button" onClick={turnOn} disabled={busy} className={buttonClass}>
            {busy ? t("turningOn") : t("turnOn")}
          </button>
        </div>
      )}
      {state === "on" && (
        <>
          <p role="status" className="text-sm">{t("isOn")}</p>
          <div>
            <button type="button" onClick={turnOff} disabled={busy} className={secondaryButtonClass}>
              {busy ? t("turningOff") : t("turnOff")}
            </button>
          </div>
        </>
      )}
      <ErrorText message={error} />
    </div>
  );
}
