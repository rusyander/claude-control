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
    id: 'copy-setup',
    module: 'conductor/copy/decide',
    decisionType: 'CopySetupDecision',
    inputs: 'mirror report, env rewrite, install plan + runs, lockfile revert, long paths',
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
] as const satisfies readonly DecisionClassDef[];

export type DecisionClassId = (typeof DECISION_CLASSES)[number]['id'];

export const DECISION_CLASS_IDS = DECISION_CLASSES.map((c) => c.id) as readonly DecisionClassId[];
