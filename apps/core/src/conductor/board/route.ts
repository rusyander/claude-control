import type { BoardEntry } from '@agentdeck/contracts/core/board';
import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import { SESSION_STEP_KINDS } from '@agentdeck/contracts/core/model-tools';
import { decideTier } from '../../economy/tier.ts';
import type { TierLadder } from '../../economy/tier.types.ts';
import { ANSWER_REVIEWERS_PRESET } from '../estimate/estimate.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
import { stepClassOf } from '../next/window.ts';
import { latestPresets } from '../scenario/presets.ts';
import type { RouteVerdict } from './launch.types.ts';

/**
 * Окно маршрута головы очереди (этап 12, P154): тот же суд `tier`, что поведёт первый шаг модели
 * будущей задачи, с вердиктами окна по маршрутам её набора. Все годные маршруты держит окно —
 * не стартует никто, голова несёт причину; `warn` — стартует с подсказкой. Пресет без шага модели
 * (или набор без маршрута — его откажет оценка с причиной) окном не держится.
 */

export interface RouteDeps {
  split(): SplitEnv | undefined;
  /** Ревью по ссылке подключено (проводка дирижёра). */
  linkWired(): boolean;
  decide(routeId: string, now: number): WindowDecision[];
  ladders: Readonly<Record<string, TierLadder>>;
  now(): number;
}

export function routeVerdict(entry: BoardEntry, deps: RouteDeps): RouteVerdict {
  const env = deps.split();
  if (!env) return { hold: 'the conductor is not running in this core' };
  // «Ответить ревьюерам» по ссылке на свой MR идёт своей дорогой (Z7, P164), не ревью по ссылке.
  if (entry.launch.kind === 'link' && entry.preset !== ANSWER_REVIEWERS_PRESET && !deps.linkWired())
    return { hold: 'review by link is not wired in this core' };
  // Последняя версия пресета — та, которой оценка развернёт `{preset}` (`scenarioRefOf`).
  const scenario = latestPresets().find((p) => p.id === entry.preset);
  const def = scenario?.steps.find((s) =>
    (SESSION_STEP_KINDS as readonly string[]).includes(s.kind),
  );
  if (!def) return { go: true };
  const allowed = env.allowedRoutes().routes;
  const now = deps.now();
  const windows = allowed.flatMap((r) => deps.decide(r.route.id, now));
  const tier = decideTier({
    taskId: entry.entryId,
    unitId: null,
    stepId: null,
    stepModel: def.model,
    allowed,
    ceiling: null,
    overrides: [],
    stepKind: def.kind,
    stepChecks: def.checks,
    stepClass: stepClassOf(def.kind),
    windows,
    ladders: deps.ladders,
    ...(entry.paidOnRefusal ? { paidOnRefusal: true } : {}),
    started: false,
  });
  if (!tier.ok) {
    if (tier.skipped.length === 0) return { go: true };
    return { hold: `route window holds the start: ${tier.reasons.join('; ')}`.slice(0, 2000) };
  }
  const warn = deps.decide(tier.route.id, now).find((d) => d.verdict === 'warn');
  if (!warn) return { go: true };
  return { go: true, hint: `route ${tier.route.id} window warning: ${warn.reasons.join('; ')}` };
}
