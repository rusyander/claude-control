import type { EnvItemKind } from '@agentdeck/contracts/portable-env';

/**
 * Набор слоёв после щелчка по одному. Порядок сохраняется от `KIND_ORDER`, а не
 * от порядка щелчков: сервер хранит список как есть, и без этого два одинаковых
 * набора отличались бы порядком — то есть выглядели бы разными подписками в
 * каждом сравнении.
 */
export function toggleLayer(
  layers: readonly EnvItemKind[],
  layer: EnvItemKind,
  order: readonly EnvItemKind[],
): EnvItemKind[] {
  const next = layers.includes(layer)
    ? layers.filter((kept) => kept !== layer)
    : [...layers, layer];
  // Вид, которого в порядке экрана нет, дописывается в конец, а не пропадает:
  // фильтр по списку экрана снимал подписку со всего, о чём этот список забыл, —
  // щелчок по соседнему слою молча отписывал бы от целого вида.
  const unknown = next.filter((kind) => !order.includes(kind));
  return [...order.filter((kind) => next.includes(kind)), ...unknown];
}
