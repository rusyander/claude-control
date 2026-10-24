/** `unknown` — поток ещё ни разу не открывался; `down` — не открылся дольше срока ожидания. */
export type ServerLinkState = 'unknown' | 'up' | 'down';
