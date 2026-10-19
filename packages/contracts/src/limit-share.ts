/**
 * Доля окна лимита подписки, потраченная прогоном, — по замерам загрузки окна.
 *
 * CLI в событии `rate_limit_event` сообщает загрузку окон подписки
 * (`rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization`, 0..1) и
 * момент их сброса (`resetsAt`). Загрузка — общая на всю подписку: в ней сразу
 * всё, что идёт параллельно (группы разделения, родитель, терминал). Поэтому
 * разница «конец − начало» у одного прогона — не его доля: при трёх группах
 * параллельно каждая насчитала бы себе всю тройную трату.
 *
 * Как делим. Все замеры всех прогонов ставятся на одну ось времени; прирост
 * между соседними замерами относится к прогонам, шедшим на этом отрезке, —
 * пропорционально токенам, которые каждый на нём потратил (токены прогона
 * считаются равномерно размазанными по его длительности). Так прирост не
 * считается дважды, сколько бы прогонов ни перекрывалось. Отрезок, на котором
 * не шёл ни один прогон, — трата снаружи (терминал, другой клиент) и не
 * достаётся никому.
 *
 * Сброс окна: `resetsAt` вырос между замерами — начинается новое окно, и
 * прирост отрезка — вся загрузка нового окна от нуля, а не (меньшая) разница
 * со старым. Отрицательного прироста не бывает: загрузка, упавшая без сброса
 * (округление на стороне сервиса), даёт ноль.
 *
 * Прогон без события (CLI не прислал его или старый CLI) своих замеров не
 * ставит, но долю на чужих отрезках получает: токены у него есть, а загрузку
 * он тратил наравне с остальными.
 *
 * Модуль без зависимостей (zod не нужен): его берут и сервер, и лента.
 */

/** Окна подписки, которые показывает панель. */
export const LIMIT_WINDOWS = ['fiveHour', 'sevenDay'] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

/** Замер одного окна: загрузка 0..1 и момент сброса окна (секунды эпохи, как в событии). */
export interface LimitWindowSample {
  utilization: number;
  resetsAt: number;
}

/** Замер в момент `at` (мс эпохи); окна, которых в событии не было, отсутствуют. */
export interface LimitSample {
  at: number;
  fiveHour?: LimitWindowSample;
  sevenDay?: LimitWindowSample;
}

/** Прогон: интервал (мс эпохи), токены и замеры (обычно начало и конец; может не быть ни одного). */
export interface LimitRun {
  id: string;
  startedAt: number;
  endedAt: number;
  tokens: number;
  samples: readonly LimitSample[];
}

/** Доля окна (0..1) по каждому окну, у которого был хоть один отрезок с приростом. */
export type LimitShare = Partial<Record<LimitWindow, number>>;

/** Прирост загрузки между двумя замерами одного окна, с учётом сброса. */
export function windowDelta(from: LimitWindowSample, to: LimitWindowSample): number {
  if (to.resetsAt > from.resetsAt) return Math.max(0, to.utilization);
  return Math.max(0, to.utilization - from.utilization);
}

/** Сколько токенов прогон потратил на отрезке [from, to] при равномерной трате. */
function tokensWithin(run: LimitRun, from: number, to: number): number {
  const duration = run.endedAt - run.startedAt;
  if (duration <= 0) return run.startedAt >= from && run.startedAt <= to ? run.tokens : 0;
  const overlap = Math.min(run.endedAt, to) - Math.max(run.startedAt, from);
  return overlap > 0 ? (run.tokens * overlap) / duration : 0;
}

/** Длительность пересечения прогона с отрезком — вес, когда токенов нет ни у кого. */
function timeWithin(run: LimitRun, from: number, to: number): number {
  return Math.max(0, Math.min(run.endedAt, to) - Math.max(run.startedAt, from));
}

/**
 * Доли окон по прогонам: `id прогона → доля`. Прогон, которому не досталось
 * ни одного отрезка с приростом, в ответе без окна (а не с нулём): «не мерили»
 * и «потратил ноль» на карточке выглядят по-разному.
 */
export function apportionLimitShare(runs: readonly LimitRun[]): Map<string, LimitShare> {
  const shares = new Map<string, LimitShare>();
  for (const window of LIMIT_WINDOWS) {
    const points = runs
      .flatMap((run) => run.samples)
      .flatMap((sample) => {
        const value = sample[window];
        return value ? [{ at: sample.at, value }] : [];
      })
      .sort((left, right) => left.at - right.at);

    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      if (!from || !to) continue;
      const delta = windowDelta(from.value, to.value);
      if (delta <= 0) continue;
      let weights = runs.map((run) => tokensWithin(run, from.at, to.at));
      let total = weights.reduce((sum, weight) => sum + weight, 0);
      // Токенов на отрезке нет ни у кого (прогоны без учёта токенов) — делим по времени.
      if (total <= 0) {
        weights = runs.map((run) => timeWithin(run, from.at, to.at));
        total = weights.reduce((sum, weight) => sum + weight, 0);
      }
      if (total <= 0) continue;
      runs.forEach((run, runIndex) => {
        const weight = weights[runIndex] ?? 0;
        if (weight <= 0) return;
        const share = shares.get(run.id) ?? {};
        share[window] = (share[window] ?? 0) + (delta * weight) / total;
        shares.set(run.id, share);
      });
    }
  }
  return shares;
}

/** Сложить доли (звенья группы, прогоны чата); окно есть, если оно есть хоть у одного слагаемого. */
export function sumLimitShares(parts: readonly (LimitShare | undefined)[]): LimitShare | undefined {
  let sum: LimitShare | undefined;
  for (const part of parts) {
    if (!part) continue;
    for (const window of LIMIT_WINDOWS) {
      const value = part[window];
      if (value === undefined) continue;
      sum = sum ?? {};
      sum[window] = (sum[window] ?? 0) + value;
    }
  }
  return sum;
}
