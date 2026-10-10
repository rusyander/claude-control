import type { DiscoveredIntegration, IntegrationId } from '@agentdeck/contracts';

/** Находку можно перенести: всё на месте и это не то же, что уже сохранено. */
export function isTransferable(item: DiscoveredIntegration): boolean {
  return item.missing.length === 0 && !item.alreadyConnected;
}

/**
 * Что отмечено сразу: всё переносимое, но по одной находке на интеграцию.
 *
 * Два сервера на один GitLab — обычное дело (общий и проектный), и сервер
 * откажет, если отметить оба. Первым идёт общий: находки приходят в порядке
 * источников, `~/.claude.json` раньше проектов.
 */
export function defaultSelection(found: readonly DiscoveredIntegration[]): string[] {
  const taken = new Set<IntegrationId>();
  const keys: string[] = [];
  for (const item of found) {
    if (!isTransferable(item) || taken.has(item.id)) continue;
    taken.add(item.id);
    keys.push(item.key);
  }
  return keys;
}

/** Интеграция, для которой отмечено больше одной находки; нет — `undefined`. */
export function doubledIntegration(
  found: readonly DiscoveredIntegration[],
  selected: readonly string[],
): IntegrationId | undefined {
  const ids = found.filter((item) => selected.includes(item.key)).map((item) => item.id);
  return ids.find((id, index) => ids.indexOf(id) !== index);
}
