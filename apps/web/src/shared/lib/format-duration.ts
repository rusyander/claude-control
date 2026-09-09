import type { TFunction } from 'i18next';

/**
 * Короткая длительность: `4с`, `1м 12с`, `1ч 03м`.
 *
 * Два разряда, не три: секунды при часах никому не нужны, а минуты при часах
 * — с ведущим нулём, чтобы `1ч 03м` и `1ч 30м` не читались одинаково на бегу.
 * Единицы — из словаря (`common.duration`): бейдж времени и сводка групп
 * показывают одно и то же на обоих языках.
 */
export function formatDuration(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = t('common.duration.h');
  const m = t('common.duration.m');
  const s = t('common.duration.s');
  if (total < 60) return `${total}${s}`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}${m} ${String(total % 60).padStart(2, '0')}${s}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${h} ${String(minutes % 60).padStart(2, '0')}${m}`;
}
