/**
 * Классы решений (00 §Decision classes, F01): ровно одна функция на класс, в одном модуле ядра.
 * Реестр — данные: тест P01 сверяет по нему каждый экспорт ядра формы «решение» (функция,
 * объявленный тип результата которой — `<…>Decision` из этого списка) с модулем-владельцем.
 * Второй судья того же класса где угодно — красный тест, а не договорённость.
 */

export interface DecisionClassDef {
  id: string;
  /** Модуль-владелец от `apps/core/src/` без расширения: файл `<module>.ts` или папка `<module>/`. */
  module: string;
  /** Имя типа результата: по нему тест находит экспорты формы «решение». */
  decisionType: string;
  inputs: string;
}

export const DECISION_CLASSES = [
  {
    id: 'check',
    module: 'verifier/decide',
    decisionType: 'CheckDecision',
    inputs: 'key, records, scope, queue, window verdict',
  },
  {
    id: 'compose',
    module: 'verifier/compose',
    decisionType: 'ComposeDecision',
    inputs: 'final tree, registry, records',
  },
  {
    id: 'window',
    module: 'economy/window',
    decisionType: 'WindowDecision',
    inputs: 'limit fact per route (window, rate, budget, slot), step class',
  },
  {
    id: 'schedule',
    module: 'conductor/schedule',
    decisionType: 'ScheduleDecision',
    inputs: 'step class, remaining estimate, learned durations',
  },
  {
    id: 'requirements',
    module: 'conductor/requirements',
    decisionType: 'RequirementsDecision',
    inputs: 'extracted list, evidence, reviewer confirmations',
  },
  {
    id: 'gates',
    module: 'conductor/gates',
    decisionType: 'GatesDecision',
    inputs:
      'step gate list, requirements verdict, latest core records, red-before, review findings/confirmations',
  },
  {
    id: 'publish-ready',
    module: 'publisher/ready',
    decisionType: 'PublishReadyDecision',
    inputs: 'composition id, base on server, outgoing content, requirements verdict',
  },
  {
    id: 'publish-text',
    module: 'publisher/text',
    decisionType: 'PublishTextDecision',
    inputs: 'commit messages, MR title/body, replies, tracker comments',
  },
  {
    id: 'continuation',
    module: 'economy/continuation',
    decisionType: 'ContinuationDecision',
    inputs: 'cache age, context size, brief size, measured costs',
  },
  {
    id: 'tier',
    module: 'economy/tier',
    decisionType: 'TierDecision',
    inputs: 'ceiling, step kind, scenario, overrides, learned failures',
  },
  {
    id: 'split-check',
    module: 'conductor/split-check',
    decisionType: 'SplitCheckDecision',
    inputs: 'units, owned paths, deps, capacity',
  },
  {
    id: 'next',
    module: 'conductor/next',
    decisionType: 'NextStepDecision',
    inputs: 'scenario, step outcome, rounds, requirements verdict',
  },
  {
    id: 'human-point',
    module: 'policy/human-point',
    decisionType: 'HumanPointDecision',
    inputs: 'action, closed list, user policy, grantRequired',
  },
  {
    id: 'authority',
    module: 'policy/authority',
    decisionType: 'AuthorityDecision',
    inputs: 'command kind, channel proof, peer process',
  },
  {
    id: 'permit',
    module: 'policy/permit',
    decisionType: 'PermitDecision',
    inputs: 'typed action, copy, grants',
  },
  {
    id: 'ownership',
    module: 'policy/ownership',
    decisionType: 'OwnershipDecision',
    inputs: 'unit owned paths, changed files',
  },
  {
    id: 'safepoint',
    module: 'conductor/safepoint',
    decisionType: 'SafepointDecision',
    inputs: 'session state, tool in flight',
  },
  {
    id: 'reconcile',
    module: 'conductor/reconcile',
    decisionType: 'ReconcileDecision',
    inputs: 'started-not-done actions + named fact reads',
  },
  {
    id: 'observer',
    module: 'observer',
    decisionType: 'SignalDecision',
    inputs: 'journal predicates',
  },
  {
    id: 'forged-publish',
    module: 'observer/forged-publish',
    decisionType: 'ForgedPublishDecision',
    inputs: 'remote refs vs step start, own-account forge events in the step window, copy closure',
  },
  {
    id: 'hook-block',
    module: 'observer/hook-block',
    decisionType: 'HookBlockDecision',
    inputs: 'hook.refused fact, the refused call, inventory hooks by event + matcher',
  },
  {
    id: 'hook-loop',
    module: 'observer/hook-loop',
    decisionType: 'HookLoopDecision',
    inputs: 'hook-block decisions of the task, current refusal key (step, hook, tool, target)',
  },
  {
    id: 'copy-setup',
    module: 'conductor/copy/decide',
    decisionType: 'CopySetupDecision',
    inputs: 'mirror report, env rewrite, install plan + runs, lockfile revert, long paths',
  },
  {
    id: 'red-before',
    module: 'conductor/outcomes/red-before',
    decisionType: 'RedBeforeDecision',
    inputs:
      'regression check of the step, changed test files, pinned base tree, check records base + copy',
  },
  {
    id: 'cleanup',
    module: 'conductor/cleanup',
    decisionType: 'CleanupDecision',
    inputs: 'resources ledger',
  },
  {
    id: 'compat',
    module: 'routes/compat',
    decisionType: 'CompatDecision',
    inputs: 'adapter caps, route caps, model facts, DLP policy, allowed set — never names',
  },
  {
    id: 'fit',
    module: 'routes/local/own/fit',
    decisionType: 'FitDecision',
    inputs: 'model size, GPU memory fact, RAM fact, overhead, tolerance',
  },
  {
    id: 'slot-wait',
    module: 'routes/local/own/slot-wait',
    decisionType: 'SlotWaitDecision',
    inputs:
      'holder liveness fact (process.alive), elapsed since restore, re-issue window, retry deadline',
  },
  {
    id: 'endpoint',
    module: 'routes/endpoint',
    decisionType: 'EndpointDecision',
    inputs:
      'server liveness fact (process.alive: pid + start), port health probe (route.availability)',
  },
  {
    id: 'budget',
    module: 'economy/budget',
    decisionType: 'BudgetDecision',
    inputs:
      'scenario step budget, learned p90 of the key, used tokens (G10) and active ms, overBudget',
  },
  {
    id: 'keep-warm',
    module: 'economy/keep-warm',
    decisionType: 'KeepWarmDecision',
    inputs:
      'session parked, last turn, context tokens, cache TTL, adapter resume, window verdict, pings, rates',
  },
  {
    id: 'set-route',
    module: 'conductor/commands/set-route',
    decisionType: 'SetRouteDecision',
    inputs: 'current allowed set, wanted set, route registry, contour policy (level 1)',
  },
  {
    id: 'precedence',
    module: 'policy/resolve',
    decisionType: 'PrecedenceDecision',
    inputs: 'key, value per level 1-5, platform floor',
  },
  {
    id: 'layer-run',
    module: 'adapters/layer-run',
    decisionType: 'LayerRunDecision',
    inputs: 'asked modes, adapter caps, trust, inventory hash',
  },
] as const satisfies readonly DecisionClassDef[];

export type DecisionClassId = (typeof DECISION_CLASSES)[number]['id'];

export const DECISION_CLASS_IDS = DECISION_CLASSES.map((c) => c.id) as readonly DecisionClassId[];

/**
 * Решение класса `precedence` (06:3-9, G1): ОДИН судья старшинства по ключу. Уровень 1 — пол
 * платформы, его не опустить; уровень 2 может расширить; уровни 3-5 только сужают — расширение
 * отвергнуто и названо (источник + почему). Решение `layer-run` — `user-layer.ts`.
 */
export interface PrecedenceDecision {
  /** `steps.<id>.checks.required`, `routes`, `humanPoints`, `userLayer.hooks`, … */
  key: string;
  value: unknown;
  sourceLevel: 1 | 2 | 3 | 4 | 5;
  source: string;
  applied: { level: number; source: string; value: unknown; note: string }[];
  rejected: { level: number; source: string; value: unknown; why: string }[];
}
