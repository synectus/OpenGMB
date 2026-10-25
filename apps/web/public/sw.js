// SynGMB service worker: push notifications only. It has no fetch handler and uses no browser
// storage, so nothing a client sees is kept on the device by it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Only a path on this site may be opened from a payload.
function safePath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

function payloadOf(event) {
  try {
    return (event.data && event.data.json()) || {};
  } catch {
    return {};
  }
}

self.addEventListener("push", (event) => {
  const data = payloadOf(event);
  const title = typeof data.title === "string" && data.title ? data.title : "OpenGMB";
  event.waitUntil(
    self.registration.showNotification(title, {
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          return w.focus().then(() => ("navigate" in w ? w.navigate(target) : undefined));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
