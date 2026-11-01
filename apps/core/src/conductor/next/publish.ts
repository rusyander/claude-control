import type { Scenario, StepDef } from '@agentdeck/contracts/core/scenario';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { TaskFoldState, UnitRecord } from '../../journal/reduce/reduce.types.ts';
import { endCode, latest } from './attempts.ts';
import {
  END_REASON,
  PUBLISH_NEXT,
  type Attempt,
  type NextAction,
  type NextInput,
  type PublishNext,
  type UnitView,
} from './next.types.ts';

/**
 * Публикация глазами судьи `next` (05 §Push and MR, §After publish; замена G8): единица идёт по
 * машине «готово к публикации» → «опубликовано» → «отвечает» → «сдано». Здесь только суд по
 * свёртке — публикует крючок `onPublish` (зона P), шаг публикации — шаг ядра.
 */

/** Единица опубликовала своё: её потребители по рёбрам могут публиковаться (P76). */
export const UNIT_PUBLISHED: ReadonlySet<string> = new Set([
  'published',
  'answering',
  'done',
  'conditional',
]);

/** Шаг правки сценария, которым идут правка по отказу и разрешение конфликта (G1). */
export function fixDefOf(scenario: Scenario): StepDef | undefined {
  return scenario.steps.find((s) => s.kind === 'fix');
}

/** `publish-refused: <next>: …` → что дальше; неизвестное — `null` (обычный провал шага). */
export function refusalNext(reason: string | undefined): PublishNext | null {
  const parts = (reason ?? '').split(':').map((p) => p.trim());
  if (parts[0] !== END_REASON.publishRefused) return null;
  return (PUBLISH_NEXT as readonly string[]).includes(parts[1] ?? '')
    ? (parts[1] as PublishNext)
    : null;
}

/** Нужен ли ответ: открытая нить ревьюера или конфликт по единственному чтению при открытии MR. */
export function needsAnswer(state: TaskFoldState, unitId: string): boolean {
  const read = publicationOf(state, unitId).read;
  return read !== null && (read.conflict || read.threads.some((t) => !t.resolved));
}

/** Есть открытые нити (без конфликта): только им нужен шаг ответа ревьюерам. */
function openThreads(state: TaskFoldState, unitId: string): number {
  return publicationOf(state, unitId).read?.threads.filter((t) => !t.resolved).length ?? 0;
}

/** Хоть один шаг единицы сдан после попытки `after` — средство отказа сработало, публикуем снова. */
function remedied(view: UnitView, after: Attempt): boolean {
  for (const list of view.byDef.values()) {
    for (const a of list) {
      if (a.stepId === after.stepId) continue;
      if (a.rec.state === 'done' && a.rec.startedSeq > after.rec.startedSeq) return true;
    }
  }
  return false;
}

function retry(unitId: string, def: StepDef, last: Attempt): NextAction {
  return { kind: 'start-step', unitId, stepDefId: def.id, round: last.rec.round + 1, why: 'retry' };
}

/** Отказ публикатора (P03): его `next` ведёт к правке, конфликту, вопросу, ожиданию форжа. */
function afterRefusal(
  input: NextInput,
  scenario: Scenario,
  view: UnitView,
  def: StepDef,
  last: Attempt,
  next: PublishNext,
): NextAction {
  const { state } = input;
  const unitId = view.unitId;
  if (remedied(view, last)) return retry(unitId, def, last);
  if (next === 'wait-forge') {
    // Ждёт только публикация этой единицы (P77): срок — от стены строки `publish.backoff`.
    const backoff = publicationOf(state, unitId).backoff;
    if (backoff && backoff.seq > last.rec.startedSeq) {
      const until = backoff.at + backoff.waitMs;
      if (input.nowMs !== undefined && input.nowMs < until) {
        return {
          kind: 'wait',
          reason: `publish waits for the forge: attempt ${backoff.attempt}, ${backoff.cause}`,
          untilWallMs: until,
        };
      }
    }
    return retry(unitId, def, last);
  }
  if (next === 'ask') {
    // Готовность ждёт снятых точек человека задачи (05 §Readiness): пока хоть одна открыта —
    // ждать; все сняты — публикация снова (готовность судит заново по свежей свёртке).
    const open = Object.values(state.asks).filter((a) => a.state === 'open').length;
    if (open > 0) {
      return { kind: 'wait', reason: `publish waits for ${open} open human point(s)` };
    }
    return retry(unitId, def, last);
  }
  if (next === 'regate') {
    const gate = [...def.after]
      .map((id) => scenario.steps.find((s) => s.id === id))
      .find((s) => s?.kind === 'final-gate');
    if (!gate) return retry(unitId, def, last);
    const g = latest(view, gate.id);
    return {
      kind: 'start-step',
      unitId,
      stepDefId: gate.id,
      round: g ? g.rec.round + 1 : 0,
      why: 'stale',
    };
  }
  const fix = fixDefOf(scenario);
  if (!fix) {
    return {
      kind: 'end-unit',
      unitId,
      event: 'close',
      reason: `${last.rec.reason ?? next}: the scenario has no fix step`,
    };
  }
  const f = latest(view, fix.id);
  return {
    kind: 'start-step',
    unitId,
    stepDefId: fix.id,
    round: f ? f.rec.round + 1 : 0,
    why: next === 'resolve-conflict' ? 'resolve-conflict' : 'fix',
  };
}

/**
 * Шаг публикации, ещё не сданный. `running` — единица становится «готово к публикации»; дальше
 * порядок по рёбрам (P76): предшественник не опубликован — ждать, закрыт — единица тоже.
 */
export function publishStep(
  input: NextInput,
  scenario: Scenario,
  view: UnitView,
  unit: UnitRecord,
  def: StepDef,
): NextAction | null {
  const { state } = input;
  const unitId = view.unitId;
  if (unit.state === 'running') {
    return {
      kind: 'end-unit',
      unitId,
      event: 'ready',
      reason: 'all steps before publish satisfied',
    };
  }
  const closed = unit.after.filter((id) => state.units[id]?.state === 'closed');
  if (closed.length > 0) {
    return {
      kind: 'end-unit',
      unitId,
      event: 'close',
      reason: `predecessor ${closed.join(', ')} closed before publishing`,
    };
  }
  const behind = unit.after.filter((id) => !UNIT_PUBLISHED.has(state.units[id]?.state ?? ''));
  if (behind.length > 0) {
    return { kind: 'wait', reason: `publish order: waits for unit ${behind.join(', ')}` };
  }
  const last = latest(view, def.id);
  if (!last) return { kind: 'start-step', unitId, stepDefId: def.id, round: 0, why: 'first' };
  if (last.rec.state === 'failed' && endCode(last.rec) === END_REASON.publishRefused) {
    const next = refusalNext(last.rec.reason);
    if (next) return afterRefusal(input, scenario, view, def, last, next);
  }
  // Провал без отказа (сбой, нет публикатора) — обычный провал шага, его ведёт `next.ts`.
  if (last.rec.state === 'failed') return null;
  // Сдана, но устарела (правка после MR, ответ ревьюерам с правкой): публикация снова.
  return { kind: 'start-step', unitId, stepDefId: def.id, round: last.rec.round + 1, why: 'stale' };
}

/**
 * Шаг хвоста после публикации. `ready-to-publish` с уже сданной публикацией — «опубликовано»;
 * `published` с нитями или конфликтом — «отвечает»; ответ без нитей — пропуск ядра.
 */
export function tailStep(
  state: TaskFoldState,
  view: UnitView,
  unit: UnitRecord,
  def: StepDef,
): NextAction | null {
  const unitId = view.unitId;
  if (unit.state === 'ready-to-publish') {
    return { kind: 'end-unit', unitId, event: 'published', reason: 'publish step done' };
  }
  if (def.kind !== 'answer-reviewers') return null;
  if (unit.state === 'published' && needsAnswer(state, unitId)) {
    return {
      kind: 'end-unit',
      unitId,
      event: 'threads-found',
      reason: 'reviewer threads or a conflict at MR open',
    };
  }
  if (openThreads(state, unitId) > 0) return null;
  const last = latest(view, def.id);
  return {
    kind: 'skip-step',
    unitId,
    stepDefId: def.id,
    round: last ? last.rec.round + 1 : 0,
    basis: 'core',
    reason: `${END_REASON.noThreads}: no reviewer threads`,
  };
}

/**
 * «Отвечает» с конфликтом (G14): после MR — шаг правки сливает базу, один раз на чтение; никакой
 * перебазировки и силы. Правка уже шла после чтения — дальше обычный ход хвоста.
 */
export function resolveConflict(
  state: TaskFoldState,
  scenario: Scenario,
  view: UnitView,
  unit: UnitRecord,
): NextAction | null {
  const read = publicationOf(state, view.unitId).read;
  if (unit.state !== 'answering' || !read?.conflict) return null;
  const fix = fixDefOf(scenario);
  if (!fix) return null;
  const f = latest(view, fix.id);
  if (f && f.rec.startedSeq > read.seq) return null;
  return {
    kind: 'start-step',
    unitId: view.unitId,
    stepDefId: fix.id,
    round: f ? f.rec.round + 1 : 0,
    why: 'resolve-conflict',
  };
}

/** Все шаги сданы: событие машины единицы по её состоянию. */
export function unitEndEvent(
  unit: UnitRecord,
  publishes: boolean,
): Extract<NextAction, { kind: 'end-unit' }>['event'] {
  switch (unit.state) {
    case 'ready-to-publish':
      return 'published';
    case 'published':
      return 'no-threads';
    case 'answering':
      return 'answered';
    default:
      return publishes ? 'ready' : 'close';
  }
}
