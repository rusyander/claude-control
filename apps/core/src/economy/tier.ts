import { EFFORT_NEVER, PLANNING_KINDS, effortRank, modelRank, topEffort } from './tier-ladder.ts';
import type {
  AllowedRoute,
  OverrideRow,
  PickSource,
  TierApplied,
  TierDecision,
  TierInput,
  TierLadder,
  TierSkip,
} from './tier.types.ts';
import { routeWait } from './window/index.ts';

/**
 * Модель шага (03 §Economy, 11 §Policy): единственный судья класса `tier`. Выбор — только внутри
 * разрешённого набора; правка человека побеждает (P35: одно предупреждение, если ревьюер слабее
 * автора); уровень сценария: `ceiling` — модель человека, `raise-for-planning` — усилие плана до
 * `xhigh` (никогда `max`), `lower-if-mechanical` — ступень ниже под теми же проверками и
 * ревьюером не слабее автора; падение на пониженной — повтор на потолке. Подписка раньше
 * платного (P117): окно, отказавшее входу CLI, не уводит шаг на ключ API без «платного при
 * отказе» этой задачи. Маршрут, который окно держит или исчерпало, не выбирается; остальные
 * годные маршруты названы как кандидаты подмены (P110). Правка `set-model`/`set-cli`
 * проверяется этой же функцией.
 */

/** Шаблон модели набора: «*» — любая последовательность; без звезды — ровно это имя. */
export function modelMatches(pattern: string, model: string): boolean {
  if (!pattern.includes('*')) return pattern === model;
  const parts = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`).test(model);
}

const sameRoute = (a: AllowedRoute, b: AllowedRoute): boolean =>
  a.adapter === b.adapter &&
  a.route.kind === b.route.kind &&
  a.route.id === b.route.id &&
  a.modelPattern === b.modelPattern;

const label = (r: AllowedRoute): string =>
  `${r.adapter}/${r.route.kind}:${r.route.id}/${r.modelPattern}`;

type Field = OverrideRow['field'];
interface Picked {
  value: string | null;
  source: PickSource | null;
}

/**
 * Правка поля: шаг уже единицы, единица уже задачи; внутри уровня — последняя строка. Последняя
 * строка уровня со значением `null` снимает правку этого уровня — решает уровень шире.
 */
export function overrideFor(
  rows: readonly OverrideRow[],
  field: Field,
  ids: { taskId: string; unitId: string | null; stepId: string | null },
): Picked {
  const levels = [
    { scope: 'step', id: ids.stepId, source: 'override-step' },
    { scope: 'unit', id: ids.unitId, source: 'override-unit' },
    { scope: 'task', id: ids.taskId, source: 'override-task' },
  ] as const;
  for (const level of levels) {
    if (level.id === null) continue;
    const last = rows
      .filter((r) => r.field === field && r.scope === level.scope && r.scopeId === level.id)
      .reduce<OverrideRow | null>((max, r) => (max === null || r.seq > max.seq ? r : max), null);
    if (last?.value) return { value: last.value, source: level.source };
  }
  return { value: null, source: null };
}

const isOverride = (s: PickSource | null): boolean => s !== null && s.startsWith('override-');

/** Маршруты шага внутри набора задачи; шаг без списка берёт весь набор. */
function candidatesOf(input: TierInput): { candidates: AllowedRoute[]; dropped: AllowedRoute[] } {
  const routes = input.stepModel.routes;
  if (!routes) return { candidates: [...input.allowed], dropped: [] };
  const candidates = routes.filter((r) => input.allowed.some((a) => sameRoute(a, r)));
  const dropped = routes.filter((r) => !input.allowed.some((a) => sameRoute(a, r)));
  return { candidates, dropped };
}

/** Собственный вход CLI и локальные маршруты раньше платного ключа API (11 §Policy, P117). */
const costRank = (r: AllowedRoute): number => (r.route.kind === 'api-key' ? 1 : 0);

/**
 * Маршруты, на которых шаг этого класса ждёт окно (P122): судит `routeWait` зоны окна — отказ,
 * исчерпание и офлайн держат любой шаг с сессией, `held` — только откладываемые классы. Своего
 * набора вердиктов здесь нет: таблица окна одна.
 */
function windowSkips(input: TierInput, candidates: readonly AllowedRoute[]): TierSkip[] {
  const out: TierSkip[] = [];
  const cls = input.stepClass ?? 'work';
  for (const route of candidates) {
    const mine = (input.windows ?? []).filter((w) => w.routeId === route.route.id);
    const wait = routeWait(mine, cls);
    const first = wait.by[0];
    if (wait.wait && first) out.push({ route, verdict: first.verdict });
  }
  return out;
}

/**
 * Модель на маршруте: правка, потолок задачи, имя без звезды, выбор CLI — только под шаблоном
 * ровно `*`: модель по умолчанию неизвестна, под `claude-*` её не доказать, совместимость откажет.
 */
function modelOn(
  route: AllowedRoute,
  override: Picked,
  ceiling: string | null,
): { model: string | null; source: PickSource } | null {
  if (override.value !== null)
    return modelMatches(route.modelPattern, override.value)
      ? { model: override.value, source: override.source as PickSource }
      : null;
  if (ceiling !== null && modelMatches(route.modelPattern, ceiling))
    return { model: ceiling, source: 'ceiling' };
  if (!route.modelPattern.includes('*')) return { model: route.modelPattern, source: 'route' };
  return route.modelPattern === '*' ? { model: null, source: 'cli-default' } : null;
}

/** Ступень ниже под шаблоном маршрута; запись, не подходящая под шаблон, пропускается вниз. */
export function lowerModel(
  ladder: TierLadder | undefined,
  model: string | null,
  pattern: string,
): string | null {
  const rank = modelRank(ladder, model);
  if (!ladder || rank === null) return null;
  for (let i = rank - 1; i >= 0; i -= 1) {
    const entry = ladder.models[i] as string;
    if (modelMatches(pattern, entry)) return entry;
  }
  return null;
}

interface Pick {
  route: AllowedRoute;
  model: string | null;
  modelSource: PickSource;
  effort: string | null;
  effortSource: PickSource;
  applied: TierApplied;
  warnings: string[];
}

/** Уровень сценария над выбранной моделью: подъём усилия плана или понижение механики. */
function applyLevel(input: TierInput, pick: Pick, reasons: string[]): void {
  const level = input.stepModel.tier;
  const ladder = input.ladders?.[pick.route.adapter];
  const kind = input.stepKind;
  if (level === 'raise-for-planning') {
    if (kind === undefined || !PLANNING_KINDS.has(kind)) {
      reasons.push(
        `tier raise-for-planning ignored: step kind ${kind ?? 'unknown'} is not planning`,
      );
      return;
    }
    if (isOverride(pick.effortSource)) return;
    const top = topEffort(ladder);
    if (top === null) {
      reasons.push('tier raise-for-planning: no effort ladder for this adapter');
      return;
    }
    if ((effortRank(ladder, pick.effort) ?? -1) < (effortRank(ladder, top) as number)) {
      pick.effort = top;
      pick.effortSource = 'tier';
      pick.applied = 'raised';
      reasons.push(`effort raised to ${top} for ${kind}`);
    }
    return;
  }
  if (level !== 'lower-if-mechanical') return;
  const why: string[] = [];
  if (isOverride(pick.modelSource)) why.push('model is the user override');
  if (kind === 'review') why.push('a reviewer is never lowered (reviewer ≥ author)');
  if (input.stepChecks?.mid === 'none') why.push('no mid checks verify a lowered step');
  if (input.lowerFailedHere)
    why.push('this step already failed at the lower tier: redo at ceiling');
  const lower = lowerModel(ladder, pick.model, pick.route.modelPattern);
  if (lower === null) why.push('no lower rung on the ladder inside the route pattern');
  else if (
    input.learnedLowerFailed?.({
      adapter: pick.route.adapter,
      routeId: pick.route.route.id,
      model: lower,
    })
  )
    why.push(`learned: ${lower} failed this step kind before`);
  if (why.length > 0 || lower === null) {
    reasons.push(`tier lower-if-mechanical kept at ceiling: ${why.join('; ')}`);
    return;
  }
  pick.model = lower;
  pick.modelSource = 'tier';
  pick.applied = 'lowered';
  reasons.push(`model lowered to ${lower} (mechanical step, same checks)`);
}

/**
 * Ревьюер не слабее автора (03:139, P35). Правка человека побеждает с одним предупреждением;
 * иначе модель и усилие поднимаются до автора, а модель автора вне шаблона маршрута — отказ.
 */
function reviewerFloor(input: TierInput, pick: Pick, reasons: string[]): string | null {
  const author = input.author;
  if (input.stepKind !== 'review' || !author) return null;
  const ladder = input.ladders?.[pick.route.adapter];
  const below: string[] = [];
  let overridden = false;
  if (author.adapter === pick.route.adapter && author.model !== null) {
    const ra = modelRank(ladder, author.model);
    const rr = modelRank(ladder, pick.model);
    const weaker = ra !== null && (rr === null ? pick.model !== author.model : rr < ra);
    if (weaker) {
      below.push(`model ${pick.model ?? 'cli default'} < ${author.model}`);
      if (isOverride(pick.modelSource)) overridden = true;
      else if (modelMatches(pick.route.modelPattern, author.model)) {
        pick.model = author.model;
        pick.modelSource = 'author';
      } else
        return `reviewer cannot reach the author's model ${author.model} on ${label(pick.route)}`;
    } else if (ra === null && pick.model !== author.model)
      reasons.push(`reviewer vs author model not comparable: ${author.model} is not on the ladder`);
  }
  const ea = effortRank(ladder, author.effort);
  const er = effortRank(ladder, pick.effort);
  if (ea !== null && (er === null || er < ea)) {
    below.push(`effort ${pick.effort ?? 'cli default'} < ${author.effort}`);
    if (isOverride(pick.effortSource)) overridden = true;
    else {
      pick.effort = author.effort;
      pick.effortSource = 'author';
    }
  }
  if (below.length === 0) return null;
  if (overridden) pick.warnings.push(`reviewer below author by user override: ${below.join(', ')}`);
  else reasons.push(`reviewer raised to the author: ${below.join(', ')}`);
  return null;
}

/** Усилие, выбранное не человеком, никогда не `max`: ступень ниже, до потолка подъёма. */
function clampEffort(input: TierInput, pick: Pick, reasons: string[]): void {
  if (pick.effort !== EFFORT_NEVER || isOverride(pick.effortSource)) return;
  const top = topEffort(input.ladders?.[pick.route.adapter]);
  reasons.push(`effort ${EFFORT_NEVER} is never chosen by the core: ${top ?? 'cli default'}`);
  pick.effort = top;
  pick.effortSource = top === null ? 'cli-default' : 'tier';
}

function registered(input: TierInput, route: AllowedRoute): boolean {
  if (!input.registry) return true;
  return input.registry.ofKind(route.route.kind).some((r) => r.id === route.route.id);
}

export function decideTier(input: TierInput): TierDecision {
  const basis = 'modelled' as const;
  const ids = { taskId: input.taskId, unitId: input.unitId, stepId: input.stepId };
  const { candidates: listed, dropped } = candidatesOf(input);
  const reasons = dropped.map((r) => `step route ${label(r)} is outside the task's allowed set`);
  const unregistered = listed.filter((r) => !registered(input, r));
  for (const r of unregistered) reasons.push(`route ${label(r)} is not in the route registry`);
  const candidates = listed.filter((r) => registered(input, r));
  const skipped = windowSkips(input, candidates);
  for (const s of skipped) reasons.push(`route ${label(s.route)} skipped: window ${s.verdict}`);
  // P117: окно отказало входу CLI — ключ API того же переходника только при «платном при отказе».
  const paidBlocked = candidates.filter(
    (r) =>
      r.route.kind === 'api-key' &&
      !input.paidOnRefusal &&
      skipped.some((s) => s.route.adapter === r.adapter && s.route.route.kind === 'cli-login'),
  );
  for (const r of paidBlocked)
    reasons.push(`route ${label(r)} not taken: paid on refusal is off for this task`);
  const usable = candidates.filter(
    (r) => !skipped.some((s) => s.route === r) && !paidBlocked.includes(r),
  );
  const adapter = overrideFor(input.overrides, 'adapter', ids);
  const model = overrideFor(input.overrides, 'model', ids);
  const effort = overrideFor(input.overrides, 'effort', ids);
  const failed: string[] = [];
  if (candidates.length === 0) failed.push('no allowed route for this step');
  else if (usable.length === 0) failed.push('every allowed route of this step is held or blocked');
  const byAdapter = usable.filter((r) => adapter.value === null || r.adapter === adapter.value);
  if (usable.length > 0 && byAdapter.length === 0)
    failed.push(`adapter ${adapter.value} (${adapter.source}) is not in the allowed set`);
  const ranked = [...byAdapter].sort((a, b) => costRank(a) - costRank(b));
  const fits = ranked
    .map((route) => ({ route, pick: modelOn(route, model, input.ceiling) }))
    .filter((x) => x.pick !== null);
  // Модель судится и тогда, когда переходник уже отказан: человек видит оба препятствия разом.
  const modelPool = byAdapter.length > 0 ? byAdapter : usable;
  const modelFits = modelPool.some((route) => modelOn(route, model, input.ceiling) !== null);
  if (modelPool.length > 0 && (byAdapter.length > 0 ? fits.length === 0 : !modelFits))
    failed.push(
      model.value === null
        ? 'no model named: a pattern other than * needs a model override or a task ceiling'
        : `model ${model.value} (${model.source}) matches no allowed route pattern`,
    );
  const alternatives = fits.slice(1).map((f) => f.route);
  const counts = {
    allowed: input.allowed.length,
    dropped: dropped.length + unregistered.length,
    skipped: skipped.length,
    paidBlocked: paidBlocked.length,
    alternatives: alternatives.length,
  };
  const chosen = fits[0];
  const refuse = (why: string[]): TierDecision => ({
    ok: false,
    reasons: [...why, ...reasons],
    dropped: [...dropped, ...unregistered],
    skipped,
    alternatives,
    numbers: counts,
    basis,
  });
  if (failed.length > 0 || !chosen) return refuse(failed);
  const first = chosen.pick as { model: string | null; source: PickSource };
  let effortSource: PickSource = 'cli-default';
  if (effort.source) effortSource = effort.source;
  else if (input.stepModel.effort) effortSource = 'step';
  const pick: Pick = {
    route: chosen.route,
    model: first.model,
    modelSource: first.source,
    effort: effort.value ?? input.stepModel.effort ?? null,
    effortSource,
    applied: 'ceiling',
    warnings: [],
  };
  applyLevel(input, pick, reasons);
  const floor = reviewerFloor(input, pick, reasons);
  if (floor !== null) return refuse([floor]);
  clampEffort(input, pick, reasons);
  // Платный маршрут выбран — потому что подписки в наборе шага нет или человек его назвал.
  const viaKey = pick.route.route.kind === 'api-key';
  reasons.push(
    `route ${label(pick.route)}${viaKey ? '' : ' (no paid key first)'}`,
    `model ${pick.model ?? 'cli default'} from ${pick.modelSource}`,
  );
  const ladder = input.ladders?.[pick.route.adapter];
  const override = [adapter.source, model.source, effort.source].some(isOverride);
  // Выбранный маршрут берётся из реестра по id решения: его нет — ошибка, не тихий выбор.
  const caps = input.registry?.require(pick.route.route.id).caps;
  return {
    ok: true,
    adapter: pick.route.adapter,
    route: pick.route.route,
    modelPattern: pick.route.modelPattern,
    model: pick.model,
    effort: pick.effort,
    sources: {
      adapter: adapter.source ?? 'route',
      model: pick.modelSource,
      effort: pick.effortSource,
    },
    asked: input.stepModel.tier,
    applied: pick.applied,
    warnings: pick.warnings,
    learning: override ? 'override' : 'counted',
    dropped: [...dropped, ...unregistered],
    skipped,
    alternatives,
    reasons,
    numbers: {
      ...counts,
      modelRank: modelRank(ladder, pick.model) ?? -1,
      effortRank: effortRank(ladder, pick.effort) ?? -1,
      authorRank: modelRank(ladder, input.author?.model ?? null) ?? -1,
      warnings: pick.warnings.length,
      ...(caps ? { offline: caps.offline ? 1 : 0 } : {}),
    },
    basis,
  };
}
