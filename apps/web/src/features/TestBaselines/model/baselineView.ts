import type { ProjectTestBaseline } from '@agentdeck/contracts';

/**
 * Показ сверки скриншотов: что выбрано, чем это подписать и каким цветом.
 *
 * Логика отдельно от разметки не ради красоты: «эталона нет» и «эталон не
 * прочитался» выглядят одинаково пусто, а значат противоположное — первое
 * нормально для нового кейса, второе означает сломанный файл, и путать их
 * нельзя. Поэтому состояние точки — закрытый список, а не догадка по наличию
 * картинок.
 */

export type BaselineTone = 'success' | 'warning' | 'danger' | 'neutral';

const TONES: Record<ProjectTestBaseline['status'], BaselineTone> = {
  match: 'success',
  diff: 'warning',
  new: 'neutral',
  error: 'danger',
};

export function baselineTone(status: ProjectTestBaseline['status']): BaselineTone {
  return TONES[status] ?? 'neutral';
}
