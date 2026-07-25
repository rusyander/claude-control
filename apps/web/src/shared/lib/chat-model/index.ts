import type { ModelInfo } from '@claude-control/contracts';

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

/**
 * Список для выпадающего выбора модели по умолчанию: сперва алиасы CLI, затем
 * конкретные модели каталога.
 *
 * Алиасы и конкретные модели — разные вещи, и путать их нельзя: `opus` CLI сам
 * разворачивает в последнюю модель семейства, а `claude-opus-5` останется
 * ровно этой моделью и после выхода следующей (её потом подставит
 * автообновление). Поэтому конкретные идут отдельным блоком и подписаны id.
 */
export function modelSelectOptions(
  models: ModelInfo[],
  aliases: readonly string[],
  labelOfAlias: (alias: string) => string,
): Array<{ value: string; label: string }> {
  const options = aliases.map((alias) => ({ value: alias, label: labelOfAlias(alias) }));
  const known = new Set(aliases);

  for (const model of models) {
    if (known.has(model.id)) continue;
    known.add(model.id);
    options.push({ value: model.id, label: `${model.name} · ${model.id}` });
  }

  return options;
}

/**
 * Гарантировать, что выбранное значение есть в списке. Каталог мог не
 * скачаться (нет сети), а модель в настройках уже стоит — без этой страховки
 * выпадающий список показал бы чужое значение вместо неё.
 */
export function withCurrentValue(
  options: Array<{ value: string; label: string }>,
  value: string,
): Array<{ value: string; label: string }> {
  if (!value || options.some((option) => option.value === value)) return options;
  return [...options, { value, label: value }];
}
