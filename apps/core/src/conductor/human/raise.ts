import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { nextState, STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { AskActionKind } from '@agentdeck/contracts/core/model-tools';
import { ASK_ACTION_KINDS } from '@agentdeck/contracts/core/model-tools';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { decideHumanPoint } from '../../policy/human-point/human-point.ts';
import type { HumanLedger, RaiseDeps, RaiseInput, RaiseOutcome } from './human.types.ts';
import { readHumanLedger } from './ledger.ts';

/**
 * Один подъём вопроса человеку на все источники (G15): MCP `ask_human`/`blocker`, отказ права
 * (P130), дирижёр (6/7/8/10), сверка outbox (4). Пункт решает `decideHumanPoint` — единственный
 * судья закрытого списка; здесь только запись: решение → `human.asked` → шаг ждёт.
 *
 * Ключ `dedupe` у открытого вопроса — второго вопроса нет и строк нет: повтор того же запроса
 * права или того же круга не плодит карточки человеку. Ключ сверяется по журналу (а не по
 * памяти процесса): после перезапуска ядра открытый вопрос всё тот же.
 */

const ACTION_KINDS: ReadonlySet<string> = new Set(ASK_ACTION_KINDS);

/** Действие ядра без вида из списка — для судьи «действия нет»: прозу и чужие виды он не судит. */
function typedAction(action: RaiseInput['action']): { kind: AskActionKind; target: string } | null {
  if (!action || !ACTION_KINDS.has(action.kind)) return null;
  return { kind: action.kind as AskActionKind, target: action.target };
}

function openDuplicate(ledger: HumanLedger, dedupe: string | null) {
  if (dedupe === null) return undefined;
  return Object.values(ledger.asks).find((a) => a.state === 'open' && a.dedupe === dedupe);
}

/** Пустая политика: годится только источникам ядра — их пункт назван, политика не читается. */
const NAMED_ONLY: RaiseDeps['policy'] = {
  actionClasses: [],
  pathGlobs: [],
  grantRequired: [],
  trackerWrites: 'auto',
  forgeWrites: 'auto',
};

/**
 * `deps.policy` обязателен вопросам модели (пункты 5 и 9 — из политики человека); дирижёр и сверка
 * называют пункт сами и зовут без неё. Вопрос модели без политики — ошибка сборки, а не молча
 * пустой список: пустой список снял бы пункты человека.
 */
export function raiseHumanPoint(
  task: LiveTask,
  raise: RaiseInput,
  deps?: RaiseDeps,
  ledger: () => HumanLedger = () => readHumanLedger(task),
): RaiseOutcome {
  const modelSource = raise.source === 'ask_human' || raise.source === 'blocker';
  if (modelSource && !deps) throw new Error(`raise from ${raise.source} needs the human policy`);
  const dup = openDuplicate(ledger(), raise.dedupe);
  if (dup) {
    return { kind: 'duplicate', askId: dup.askId, point: dup.point, blocking: dup.blocking };
  }
  const decision = decideHumanPoint(
    {
      source: raise.source,
      point: raise.point,
      action: typedAction(raise.action),
      question: raise.question,
      options: raise.options,
      recommendation: raise.recommendation,
      blocking: raise.blocking,
    },
    deps?.policy ?? NAMED_ONLY,
  );
  const where = {
    ...(raise.stepId ? { stepId: raise.stepId } : {}),
    ...(raise.sessionId ? { sessionId: raise.sessionId } : {}),
  };
  const common = { source: raise.source, dedupe: raise.dedupe };
  let output: JournalDataV1['decision']['output'];
  if (decision.point !== null) {
    output = { ...common, point: decision.point, blocking: decision.blocking };
  } else if ('fork' in decision) {
    output = { ...common, point: null, blocking: false, fork: { ...decision.fork } };
  } else {
    output = { ...common, point: null, blocking: false, refused: true };
  }
  const decided = task.append({
    kind: 'decision',
    actor: 'core',
    ...where,
    data: {
      decisionId: newId(),
      class: 'human-point',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [decision.reason],
      output,
    },
  });
  if (decision.point === null) {
    return 'fork' in decision
      ? {
          kind: 'fork',
          proceedWith: raise.recommendation,
          reason: decision.reason,
          decisionSeq: decided.seq,
        }
      : { kind: 'refused', reason: decision.reason, decisionSeq: decided.seq };
  }
  const askId = newId();
  task.append({
    kind: 'human.asked',
    actor: 'core',
    ...where,
    cause: decided.seq,
    data: {
      askId,
      point: decision.point,
      source: raise.source,
      dedupe: raise.dedupe,
      question: raise.question,
      options: raise.options,
      // Умолчание — только у неблокирующего: по нему шаг продолжает, пока человек молчит.
      defaultAction: decision.blocking ? null : raise.recommendation,
    },
  });
  let waiting = false;
  const step = raise.stepId ? task.state.steps[raise.stepId] : undefined;
  if (decision.blocking && raise.stepId && step) {
    const moved = nextState(STEP_MACHINE, step.state, 'ask');
    if (moved.ok) {
      task.append({
        kind: 'step.transition',
        actor: 'core',
        stepId: raise.stepId,
        cause: decided.seq,
        data: { stepId: raise.stepId, event: 'ask', from: step.state, to: moved.to },
      });
      waiting = true;
    }
  }
  return {
    kind: 'asked',
    askId,
    point: decision.point,
    blocking: decision.blocking,
    waiting,
    decisionSeq: decided.seq,
  };
}
