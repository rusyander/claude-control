/**
 * Общие константы выбора модели и глубины продумывания. Живут в shared, чтобы
 * ими одинаково пользовались и пикер в шапке чата, и настройки (глобальный
 * дефолт). Логика «дефолт из настроек + локальный оверрайд чата» — на странице
 * чата (там доступны и настройки-entity, и per-chat черновик).
 */

/**
 * Алиасы моделей CLI для выбора. '' = как выберет Claude (по умолчанию).
 *
 * `fable` здесь потому, что он — верхняя ступень лестницы подбора
 * (`MODEL_RANK` в `contracts/model-cascade`), и без него потолок разговора нельзя
 * было поставить на неё иначе как конкретным именем из каталога: подбор считает
 * ранг по семейству, а список выбора о самом сильном семействе молчал. Доступ к
 * нему зависит от аккаунта — как и к любому имени из каталога, который панель
 * показывает целиком.
 */
export const MODEL_OPTIONS = ['', 'fable', 'opus', 'sonnet', 'haiku'] as const;

/** Уровни глубины продумывания (--effort). '' = по умолчанию. */
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** «opus» → «Opus»; пусто отдаём как есть (подпишут отдельно). */
export function modelLabel(model: string): string {
  return model ? model.charAt(0).toUpperCase() + model.slice(1) : '';
}

export type { PlatformRefusalParams } from './index.types';
export { modelSelectOptions } from './modelSelectOptions';
export { platformRunChoice } from './platformRunChoice';
export { platformModelCaption, type PlatformModelCaption } from './platformModelCaption';
export { platformRefusalCaption } from './platformRefusalCaption';
export { platformBypassCaption } from './platformBypassCaption';
export { platformLayersCaption, type PlatformLayersCaption } from './platformLayersCaption';
export { withCurrentValue } from './withCurrentValue';
