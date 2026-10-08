import type { PathEntry } from '@agentdeck/contracts';

/**
 * Самое верхнее место вставки. У конвейера первая строка — стадия, и встать
 * выше неё нельзя: сервер всё равно поставит шаг после стадии. У сценария
 * стадий нет — шаг можно положить в самое начало (`-1`).
 */
export function topSlot(entries: PathEntry[]): -1 | 0 {
  return entries[0]?.kind === 'builtin' ? 0 : -1;
}
