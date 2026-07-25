import type { ModelInfo, ModelPromotion } from '@claude-control/contracts';
import { releaseKey } from './model-source.ts';

/**
 * Автоматическая замена модели по умолчанию на более новую.
 *
 * Зачем вообще: алиас (`opus`) CLI сам разворачивает в последнюю модель, а вот
 * пришпиленный в настройках `claude-opus-4-8` остаётся прошлым поколением
 * навсегда — молча, пока человек не вспомнит про него сам. Панель знает даты
 * выхода, поэтому может заметить смену поколения и переставить дефолт.
 *
 * Границы намеренно узкие:
 * - только внутри ОДНОГО семейства (`claude-opus` → `claude-opus`): подмена
 *   opus на sonnet — это смена класса модели и денег, а не обновление;
 * - только если в настройках стоит модель, которую панель нашла в каталоге:
 *   алиас, пустое значение и незнакомая строка не трогаются вовсе;
 * - только вперёд по дате выхода.
 */
export function findNewerModel(models: ModelInfo[], currentId: string): ModelInfo | undefined {
  const current = models.find((model) => model.id === currentId);
  if (!current?.family) return undefined;

  return newestInFamily(models, current.family, { after: current.releaseDate });
}

/** Самая свежая модель семейства. `after` — брать только новее этой даты. */
export function newestInFamily(
  models: ModelInfo[],
  family: string,
  options: { after?: string } = {},
): ModelInfo | undefined {
  const floor = releaseKey(options.after);

  let best: ModelInfo | undefined;

  for (const model of models) {
    if (model.family !== family) continue;
    if (options.after !== undefined && releaseKey(model.releaseDate) <= floor) continue;
    if (!best || releaseKey(model.releaseDate) > releaseKey(best.releaseDate)) best = model;
  }

  return best;
}

/**
 * Решение об автозамене дефолта чата. `undefined` — менять нечего.
 *
 * Экспериментальные модели здесь НЕ отбрасываются: источник помечает так и
 * свежие флагманы (Opus 5 в их числе), а именно их появления пользователь и
 * ждёт. Риска в этом нет: меняется настройка панели, обратимая одним выбором.
 */
export function planDefaultPromotion(
  models: ModelInfo[],
  currentId: string,
  at: string,
): ModelPromotion | undefined {
  if (!currentId) return undefined;

  const next = findNewerModel(models, currentId);
  if (!next) return undefined;

  return { from: currentId, to: next.id, toName: next.name, at };
}

/**
 * Модель для встроенного ассистента панели (тот, что заполняет формы через
 * API-ключ пользователя). В коде зашита осознанно скромная модель; каталог
 * подтягивает её актуальное поколение того же семейства.
 *
 * Семейство здесь и есть страховка по деньгам: `gpt-mini` остаётся `gpt-mini`,
 * а не превращается во флагман. Не нашли семейство — остаёмся на зашитом
 * значении: этот вызов идёт по платному ключу пользователя.
 */
export function resolveAssistantModel(models: ModelInfo[], fallbackId: string): string {
  const current = models.find((model) => model.id === fallbackId);
  if (!current?.family) return fallbackId;

  const newest = newestInFamily(models, current.family, { after: current.releaseDate });
  return newest?.id ?? fallbackId;
}
