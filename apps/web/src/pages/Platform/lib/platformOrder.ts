import type { PlatformStatus } from '@agentdeck/contracts';

/**
 * Порядок карточек раздела: активный контур первым, остальные — как пришли с
 * сервера. Активный — единственный, через который сейчас идёт работа, и искать
 * его третьим в списке тестовых подключений человек не должен (владелец,
 * 14.09.2026). Сортировка устойчивая: соседи между собой не перемешиваются.
 */
export function activeFirst(
  platforms: readonly PlatformStatus[] | undefined,
): PlatformStatus[] | undefined {
  if (!platforms) return undefined;
  return [...platforms].sort(
    (left, right) => Number(right.platform.enabled) - Number(left.platform.enabled),
  );
}
