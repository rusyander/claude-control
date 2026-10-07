/** Префиксы вида «XXX-9», которые ключом задачи трекера не бывают. */
const NOT_TRACKER = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'CVE', 'TLS', 'HTTP', 'MD', 'ES', 'IEC']);

/** Ключи задач трекера (`PROJ-1064`) в тексте — по порядку, без повторов. */
export function trackerKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,6})\b/g)) {
    if (NOT_TRACKER.has(match[1] ?? '')) continue;
    if (!keys.includes(match[0])) keys.push(match[0]);
  }
  return keys;
}
