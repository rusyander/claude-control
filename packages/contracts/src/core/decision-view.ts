import type { DecisionClassId } from './decisions.ts';
import { SIGNAL_ACTIONS, WINDOW_VERDICTS } from './journal-data.ts';

/**
 * Исход решения для человека (07:21, этап 9, развилка F1): строка `decision` несёт причины
 * английской прозой (P32 — их показывают дословно под «детали»), а заголовок ленты строится
 * шаблоном ru/en по паре «класс × исход». Здесь — ЗАКРЫТЫЙ список исходов каждого класса и
 * одно чтение исхода из `output` строки. Шаблоны панели типизированы этим списком: новый исход
 * без шаблона не соберётся, а исход, которого ядро не пишет, тест ядра назовёт (каждое решение
 * библиотеки заглушек обязано попасть в объявленный исход).
 */

const SIGNAL_OUTCOMES = ['quiet', ...SIGNAL_ACTIONS] as const;

export const DECISION_OUTCOMES = {
  check: ['replay', 'run', 'narrow', 'wait', 'defer', 'refuse', 'absent'],
  compose: ['ready', 'run', 'refuse'],
  window: WINDOW_VERDICTS,
  schedule: ['granted', 'waiting'],
  requirements: ['covered', 'uncovered'],
  gates: ['passed', 'closed'],
  'publish-ready': ['allow', 'refuse'],
  'publish-text': ['pass', 'stripped', 'refused'],
  continuation: ['same-session', 'fresh'],
  tier: ['picked', 'refused'],
  'split-check': ['accepted', 'refused'],
  next: [
    'create-unit',
    'start-unit',
    'start-step',
    'reenter-step',
    'run-step',
    'run-core-step',
    'post-step',
    'remind',
    'derive-outcome',
    'stop-step',
    'park-session',
    'extend-budget',
    'extend-tokens',
    'answered',
    'close-human-step',
    'raise',
    'skip-step',
    'end-unit',
    'finish-task',
    'fail-task',
    'cancel-task',
    'wait',
  ],
  'human-point': ['blocking', 'non-blocking', 'fork', 'refused'],
  authority: ['allow', 'refuse'],
  permit: ['allow', 'deny'],
  ownership: ['inside', 'outside'],
  safepoint: ['safe', 'unsafe'],
  reconcile: ['happened', 'not-happened', 'retry', 'ask'],
  observer: SIGNAL_OUTCOMES,
  'forged-publish': SIGNAL_OUTCOMES,
  'hook-block': SIGNAL_OUTCOMES,
  'hook-loop': SIGNAL_OUTCOMES,
  'copy-setup': ['ready', 'ready-with-gaps', 'failed'],
  'red-before': ['proven', 'unproven', 'unknown'],
  cleanup: ['release', 'keep'],
  compat: ['direct', 'via-gateway', 'refused'],
  fit: ['fits', 'short'],
  'slot-wait': ['hold', 'retry', 'release', 'foreign', 'adopt', 'human-point'],
  endpoint: ['serve', 'refuse'],
  budget: ['within', 'over'],
  'keep-warm': ['ping', 'skip'],
  'set-route': ['applied', 'refused'],
  precedence: ['within-levels', 'widening-rejected'],
  'layer-run': ['as-asked', 'lowered'],
} as const satisfies Record<DecisionClassId, readonly string[]>;

export type DecisionOutcome<C extends DecisionClassId = DecisionClassId> =
  (typeof DECISION_OUTCOMES)[C][number];

type Out = Record<string, unknown>;

const str = (o: Out, key: string): string | undefined =>
  typeof o[key] === 'string' ? (o[key] as string) : undefined;
const bool = (o: Out, key: string): boolean | undefined =>
  typeof o[key] === 'boolean' ? (o[key] as boolean) : undefined;
const pick = <T extends string>(flag: boolean | undefined, yes: T, no: T): T | undefined =>
  flag === undefined ? undefined : flag ? yes : no;
const nonEmpty = (o: Out, key: string): boolean | undefined =>
  Array.isArray(o[key]) ? (o[key] as unknown[]).length > 0 : undefined;

/** Решение наблюдателя (`SignalDecision`): не сработал — «тихо», иначе действие для дирижёра. */
const signal = (o: Out): string | undefined => {
  const fired = bool(o, 'fired');
  if (fired === undefined) return undefined;
  return fired ? str(o, 'action') : 'quiet';
};

/**
 * Где у каждого класса лежит исход — форма `output`, как её пишет ядро (одна запись на класс; у
 * `next` выход — само действие, у `tier` отказ — `refused: true`, у `precedence` — `{keys}`).
 */
const READ: { [C in DecisionClassId]: (o: Out) => string | undefined } = {
  check: (o) => str(o, 'kind'),
  compose: (o) => str(o, 'kind'),
  window: (o) => str(o, 'verdict'),
  schedule: (o) => pick(nonEmpty(o, 'grant'), 'granted', 'waiting'),
  requirements: (o) => pick(bool(o, 'covered'), 'covered', 'uncovered'),
  gates: (o) => pick(bool(o, 'passed'), 'passed', 'closed'),
  'publish-ready': (o) => str(o, 'kind'),
  'publish-text': (o) => str(o, 'kind'),
  continuation: (o) => str(o, 'mode'),
  tier: (o) => (o.refused === true ? 'refused' : str(o, 'adapter') ? 'picked' : undefined),
  'split-check': (o) => str(o, 'verdict'),
  next: (o) => str(o, 'kind'),
  'human-point': (o) => {
    if (typeof o.point === 'number') return pick(bool(o, 'blocking'), 'blocking', 'non-blocking');
    if (o.point !== null) return undefined;
    if (o.fork !== undefined && o.fork !== null) return 'fork';
    return o.refused === true ? 'refused' : undefined;
  },
  authority: (o) => pick(bool(o, 'allow'), 'allow', 'refuse'),
  permit: (o) => pick(bool(o, 'allow'), 'allow', 'deny'),
  ownership: (o) => str(o, 'verdict'),
  safepoint: (o) => pick(bool(o, 'safe'), 'safe', 'unsafe'),
  reconcile: (o) => str(o, 'verdict'),
  observer: signal,
  'forged-publish': signal,
  'hook-block': signal,
  'hook-loop': signal,
  'copy-setup': (o) => str(o, 'verdict'),
  // Доказательство не состоялось (реестр или записи не прочитаны) — выход `{checkId, unknown}`.
  'red-before': (o) =>
    typeof o.unknown === 'string' ? 'unknown' : pick(bool(o, 'proven'), 'proven', 'unproven'),
  cleanup: (o) => pick(nonEmpty(o, 'release'), 'release', 'keep'),
  compat: (o) => str(o, 'kind'),
  fit: (o) => str(o, 'kind'),
  'slot-wait': (o) => str(o, 'action'),
  endpoint: (o) => str(o, 'kind'),
  budget: (o) => pick(nonEmpty(o, 'over'), 'over', 'within'),
  'keep-warm': (o) => str(o, 'kind'),
  'set-route': (o) => pick(bool(o, 'ok'), 'applied', 'refused'),
  precedence: (o) => {
    if (!Array.isArray(o.keys)) return undefined;
    const rejected = (o.keys as unknown[]).some(
      (k) =>
        typeof k === 'object' &&
        k !== null &&
        Array.isArray((k as Out).rejected) &&
        ((k as Out).rejected as unknown[]).length > 0,
    );
    return rejected ? 'widening-rejected' : 'within-levels';
  },
  'layer-run': (o) => {
    const asked = o.asked as Out | undefined;
    const ran = o.ran as Out | undefined;
    if (typeof asked !== 'object' || typeof ran !== 'object' || !asked || !ran) return undefined;
    return asked.hooks === ran.hooks && asked.skills === ran.skills ? 'as-asked' : 'lowered';
  },
};

export function isDecisionClass(cls: string): cls is DecisionClassId {
  return Object.hasOwn(DECISION_OUTCOMES, cls);
}

/**
 * Исход строки решения или `null`: класс не из реестра, выход не той формы или исход вне
 * объявленного списка. `null` в панели — «решение без шаблона» с причинами дословно, никогда
 * не выдуманный заголовок.
 */
export function decisionOutcome<C extends DecisionClassId>(
  cls: C,
  output: unknown,
): DecisionOutcome<C> | null;
export function decisionOutcome(cls: string, output: unknown): DecisionOutcome | null;
export function decisionOutcome(cls: string, output: unknown): DecisionOutcome | null {
  if (!isDecisionClass(cls)) return null;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null;
  const outcome = READ[cls](output as Out);
  const declared: readonly string[] = DECISION_OUTCOMES[cls];
  return outcome !== undefined && declared.includes(outcome) ? (outcome as DecisionOutcome) : null;
}
