import type { AllowedRoute, TierInput, TierSkip } from './tier.types.ts';

/**
 * Начатая задача и окно (P169, D19 этапа 12): когда у задачи уже шла сессия, суд `tier` не уводит
 * шаг с планового маршрута из-за окна — ни на другую модель, ни на другой CLI. Плановый маршрут —
 * тот, что суд выбрал бы без окон; держит его окно — шаг ждёт, а годные маршруты набора только
 * предлагаются человеку (`offers`). Заранее разрешён один переход: ключ API того же CLI при
 * «платном при отказе» этой задачи (P117). Первая сессия задачи — выбор на запуске, как раньше.
 */

/** Собственный вход CLI и локальные маршруты раньше платного ключа API (11 §Policy, P117). */
export const costRank = (r: AllowedRoute): number => (r.route.kind === 'api-key' ? 1 : 0);

/** Шаблон модели набора: «*» — любая последовательность; без звезды — ровно это имя. */
export function modelMatches(pattern: string, model: string): boolean {
  if (!pattern.includes('*')) return pattern === model;
  const parts = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`).test(model);
}

export type StartedHold =
  /** Задача не начата или планового маршрута нет вовсе — выбор идёт как обычно. */
  | null
  /** Плановый маршрут годен — шаг идёт им, а не самым дешёвым годным. */
  | { kind: 'keep'; route: AllowedRoute }
  /** Окно отказало входу CLI, «платный при отказе» включён: ключ API того же CLI. */
  | { kind: 'paid'; route: AllowedRoute }
  /** Плановый маршрут держит окно: шаг ждёт его, варианты — только кликом человека. */
  | { kind: 'wait'; planned: AllowedRoute; skip: TierSkip | null; offers: string[] };

/**
 * Что человек может выбрать кликом вместо ждущего маршрута: другой CLI набора (`cli:<id>`) или
 * модель, которую несёт только другой маршрут того же CLI (`model:<id>`, шаблон без звезды и не
 * под шаблоном планового — иначе правка модели оставила бы шаг на том же маршруте). Модель, которой
 * нет в прочитанном списке моделей маршрута, не предлагается: клик упёрся бы в отказ `compat`
 * `model_absent` и сжёг бы попытки шага. Платный ключ API — только при «платном при отказе» задачи.
 */
export function offersOf(
  input: Pick<TierInput, 'paidOnRefusal' | 'servedModels'>,
  planned: AllowedRoute,
  usable: readonly AllowedRoute[],
): string[] {
  const out: string[] = [];
  const add = (o: string): void => {
    if (!out.includes(o)) out.push(o);
  };
  const served = (r: AllowedRoute): boolean => {
    const list = input.servedModels?.(r.route.id) ?? null;
    return list === null || list.includes(r.modelPattern);
  };
  for (const r of [...usable].sort((a, b) => costRank(a) - costRank(b))) {
    if (r.route.kind === 'api-key' && input.paidOnRefusal !== true) continue;
    if (r.adapter !== planned.adapter) add(`cli:${r.adapter}`);
    else if (
      !r.modelPattern.includes('*') &&
      !modelMatches(planned.modelPattern, r.modelPattern) &&
      served(r)
    )
      add(`model:${r.modelPattern}`);
  }
  return out;
}

/**
 * Плановый маршрут начатой задачи — маршрут её последней сессии, если он есть в наборе шага и
 * несёт модель: окно, отказавшее на запуске, уже увело первую сессию (выбор на запуске), и «выбор
 * без окон» вернул бы задачу назад, как только то окно откроется, или поставил бы её ждать чужой
 * маршрут, пока свой годен (ревью этапа 12). Сессия шла на ключе API, а вход того же CLI в наборе —
 * плановый вход: ключ брался только «платным при отказе» (P117), CLI тот же. Нет такой — выбор без
 * окон, как раньше.
 */
function plannedOf(
  input: Pick<TierInput, 'startedOn'>,
  pool: readonly AllowedRoute[],
  fits: (route: AllowedRoute) => boolean,
): AllowedRoute | undefined {
  const fitting = [...pool].sort((a, b) => costRank(a) - costRank(b)).filter(fits);
  const on = input.startedOn;
  const own = on
    ? fitting.find(
        (r) =>
          r.adapter === on.adapter && r.route.kind === on.route.kind && r.route.id === on.route.id,
      )
    : undefined;
  const login =
    own?.route.kind === 'api-key'
      ? fitting.find((r) => r.adapter === own.adapter && r.route.kind === 'cli-login')
      : undefined;
  return login ?? own ?? fitting[0];
}

/**
 * Суд начатой задачи над плановым маршрутом. `pool` — маршруты набора под правкой CLI, без учёта
 * окна; `fits(route)` — подходит ли маршрут под модель (тот же суд модели, что у выбора).
 */
export function startedHold(
  input: Pick<TierInput, 'started' | 'paidOnRefusal' | 'startedOn' | 'servedModels'>,
  pool: readonly AllowedRoute[],
  usable: readonly AllowedRoute[],
  skipped: readonly TierSkip[],
  fits: (route: AllowedRoute) => boolean,
): StartedHold {
  if (input.started !== true) return null;
  const planned = plannedOf(input, pool, fits);
  if (!planned) return null;
  if (usable.includes(planned)) return { kind: 'keep', route: planned };
  if (input.paidOnRefusal === true && planned.route.kind === 'cli-login') {
    const key = usable.find(
      (r) => r.adapter === planned.adapter && r.route.kind === 'api-key' && fits(r),
    );
    if (key) return { kind: 'paid', route: key };
  }
  // Плановый — ключ, заслонённый отказом входа того же CLI (P117): ждёт он окна входа.
  const skip =
    skipped.find((s) => s.route === planned) ??
    skipped.find(
      (s) => s.route.adapter === planned.adapter && s.route.route.kind === 'cli-login',
    ) ??
    null;
  return { kind: 'wait', planned, skip, offers: offersOf(input, planned, usable) };
}
