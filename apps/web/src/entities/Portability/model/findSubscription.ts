import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';

/**
 * Подписка выбранной цели на выбранном уровне — из общего списка.
 *
 * Уровень входит в поиск наравне с целью: подписка дома и подписка проекта —
 * РАЗНЫЕ подписки с разными корнями, и показать одну под заголовком другой
 * значило бы предложить пересобрать не те файлы.
 */
export function findSubscription(
  items: readonly EnvSubscription[],
  target: string,
  scope: string,
  project = '',
): EnvSubscription | null {
  return (
    items.find(
      (item) => item.target === target && item.scope === scope && (item.project ?? '') === project,
    ) ?? null
  );
}
