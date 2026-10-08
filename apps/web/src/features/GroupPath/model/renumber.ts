import type { PathStep, PathAnchor } from '@agentdeck/contracts';

/**
 * Номера внутри стадии по порядку списка: 0, 1, 2… Сервер сортирует по
 * `order`, поэтому дыры и повторы после вставки или удаления надо закрыть здесь.
 */
export function renumber(steps: PathStep[]): PathStep[] {
  const next = new Map<PathAnchor, number>();
  return steps.map((step) => {
    const order = next.get(step.anchor) ?? 0;
    next.set(step.anchor, order + 1);
    return step.order === order ? step : { ...step, order };
  });
}
