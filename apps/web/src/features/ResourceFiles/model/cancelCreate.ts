import type { CreateTarget } from './createTarget.types';

/** Отмена: поля больше нет. Никогда не корень — отказ ничего не открывает. */
export function cancelCreate(): CreateTarget {
  return undefined;
}
