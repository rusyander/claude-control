/**
 * Общие константы выбора модели и глубины продумывания. Живут в shared, чтобы
 * ими одинаково пользовались и пикер в шапке чата, и настройки (глобальный
 * дефолт). Логика «дефолт из настроек + локальный оверрайд чата» — на странице
 * чата (там доступны и настройки-entity, и per-chat черновик).
 */

/** Алиасы моделей CLI для выбора. '' = как выберет Claude (по умолчанию). */
export const MODEL_OPTIONS = ['', 'opus', 'sonnet', 'haiku'] as const;

/** Уровни глубины продумывания (--effort). '' = по умолчанию. */
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** «opus» → «Opus»; пусто отдаём как есть (подпишут отдельно). */
export function modelLabel(model: string): string {
  return model ? model.charAt(0).toUpperCase() + model.slice(1) : '';
}
