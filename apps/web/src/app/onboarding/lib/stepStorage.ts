/** sessionStorage может быть недоступен (приватный режим, запрет данных сайта) — тогда шаг не запоминается. */
export function stepStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
