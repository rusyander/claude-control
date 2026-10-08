/** Хранилище вкладки; сам доступ к нему бросает при запрете данных сайта. */
export function sessionStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
