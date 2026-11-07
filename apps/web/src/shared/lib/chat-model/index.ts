/**
 * Общие константы выбора модели и глубины продумывания. Живут в shared, чтобы
 * ими одинаково пользовались и пикер в шапке чата, и настройки (глобальный
 * дефолт). Логика «дефолт из настроек + локальный оверрайд чата» — на странице
 * чата (там доступны и настройки-entity, и per-chat черновик).
 */

export { MODEL_OPTIONS, EFFORT_LEVELS } from './options';
export { isClaudeModelId } from './claudeModel';

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
export { isLocalRoute, routeKey, platformTitleOf } from './localRoute';
