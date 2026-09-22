// Service worker minimo: solo existe para que Chrome ofrezca "Instalar app".
// No cachea nada (la app siempre debe traer horas frescas del Worker).
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => self.clients.claim());
self.addEventListener("fetch", () => {});
