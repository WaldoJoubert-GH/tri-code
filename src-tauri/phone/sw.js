// Remote Control's service worker: shows a pushed signal, and a tap opens that agent.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "tri-code", {
      body: d.body || "",
      tag: d.tab || undefined,
      renotify: !!d.tab,
      data: { tab: d.tab },
      icon: "/icon.png",
      badge: "/icon.png",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = e.notification.data && e.notification.data.tab;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open[0]) {
      await open[0].focus();
      open[0].postMessage({ open: tab });
      return;
    }
    await self.clients.openWindow(tab ? "/?tab=" + encodeURIComponent(tab) : "/");
  })());
});
