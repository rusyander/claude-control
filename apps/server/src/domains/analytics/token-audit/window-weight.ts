import { BUILT_IN_ENTRIES, findEntry } from '../pricing.ts';

/**
 * Вес вызова в окне подписки (W) — одна формула на измеритель (`token-audit`) и
 * живого сторожа групп (`token-ledger/watch`). Две копии разошлись бы за день,
 * как разошлась копия разбора проверок в `economy.ts`.
 *
 * W = F × (вход + 1,25·запись 5 мин + 2·запись 1 ч + 0,1·чтение кеша + 5·вывод) / 1e6,
 * F — множитель модели: цена входа её ВЕРСИИ за миллион по встроенному прайсу
 * (Opus 4.5+ 5, Opus 4/4.1 15, Sonnet 3, Haiku 4.5 1, Haiku 3.5 0,8).
 * Коэффициенты — цены API относительно входа; окно подписки, по замеру плана,
 * тратится в той же пропорции. Это оценка доли окна, не деньги.
 */

/** Токены вызова в полях измерителя (`CallTokens`): запись 1 ч — часть всей записи. */
export interface WeightTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

/** Множитель модели, о которой прайс ничего не знает, — нынешний Opus. */
const UNKNOWN_FACTOR = 5;
/** Имя модели → множитель: вызовов сотни в минуту, а поиск по прайсу сортирует его. */
const factors = new Map<string, number>();

/**
 * Множитель модели — по версии, не по семейству: Opus 4/4.1 втрое дороже
 * Opus 4.5+, и «opus → 5» занижал бы старые вызовы втрое (тот же урок, что у
 * цен аналитики). Неизвестная (нет поля, чужое имя) считается как Opus:
 * группы работают на нём, и недооценка опаснее переоценки — сигнал «жжёт» молчал бы.
 */
export function modelFactor(model: string | undefined): number {
  const name = (model ?? '').toLowerCase();
  const known = factors.get(name);
  if (known !== undefined) return known;
  const factor =
    (name ? findEntry(name, BUILT_IN_ENTRIES)?.price.input : undefined) ?? UNKNOWN_FACTOR;
  factors.set(name, factor);
  return factor;
}

/** Часовая доля записи в границах [0, вся запись]: битое поле не даёт отрицательной цены. */
export const write1hPart = (cacheWrite: number, cacheWrite1h: number): number =>
  Math.max(0, Math.min(cacheWrite1h, cacheWrite));

/** Вес одного вызова в W. Запись 5 мин = вся запись минус часовая. */
export function windowWeight(tokens: WeightTokens, model: string | undefined): number {
  const write1h = write1hPart(tokens.cacheWrite, tokens.cacheWrite1h);
  const write5m = tokens.cacheWrite - write1h;
  const units =
    tokens.input + 1.25 * write5m + 2 * write1h + 0.1 * tokens.cacheRead + 5 * tokens.output;
  return (modelFactor(model) * units) / 1e6;
}

/** Округление W для отчёта: сотые — меньше шума, чем разница двух прогонов. */
export const roundWeight = (weight: number): number => Math.round(weight * 100) / 100;
