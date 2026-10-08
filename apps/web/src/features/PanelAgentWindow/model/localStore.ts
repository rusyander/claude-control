/** Хранилище браузера; сам доступ к нему бросает при запрете данных сайта. */
export function localStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
