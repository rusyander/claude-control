import type { Predicate } from './observer.types.ts';

/**
 * Предикат с собственным типом состояния — в общий список: свёртка хранит состояние каждого
 * непрозрачно и отдаёт его обратно только ему же. Отдельный модуль, а не реестр: папки сигналов
 * импортируют его, а реестр импортирует папки — общий модуль круга не замыкает.
 */
export function erasePredicate<S>(p: Predicate<S>): Predicate {
  return p as unknown as Predicate;
}
