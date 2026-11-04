import type { Fact } from '@agentdeck/contracts/core/facts';
import { factKind } from '@agentdeck/contracts/core/facts';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { newId } from '../lib/ids/uuidv7.ts';
import { readFact, type Reader } from '../lib/facts/read-fact.ts';
import { READ_CLASSES, type ReadClassName } from '../lib/facts/read-classes.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { CONDUCTOR_QUESTIONS, answerKey, askLangOf, optionsOf } from './next/answers.ts';
import { openActions } from './outbox.ts';

/**
 * Сверка при загрузке (01 §Outbox, P86): каждое начатое и не законченное действие читает свой
 * названный факт и пишет решение — повтора вслепую нет никогда. Факт по виду действия:
 * пуш — sha удалённой ветки; MR — список по исходной ветке; ответ — заметки треда с тем же
 * хешем тела; контейнер — по метке; процесс — по метке окружения дерева; копия — каталог.
 * `unknown` → повтор до срока класса чтения, затем точка человека 4 (доступ / форж названы).
 * Срок считается от ПЕРВОЙ записанной сверки действия (строка `decision` в журнале), а не от
 * памяти процесса: иначе каждая загрузка начинала срок заново и вопрос не задавался никогда
 * (ревью F-26). Повторная `retry` того же действия в журнал не пишется — первая уже там.
 */

export const ACTION_READ_CLASS: Record<ActionKind, ReadClassName> = {
  push: 'push.remote-sha',
  'mr-create': 'mr.by-source-branch',
  'mr-update': 'mr.by-source-branch',
  'thread-reply': 'thread.reply-by-hash',
  // Та же природа чтения: своя заметка MR по хешу тела (этап 10, F8).
  'mr-comment': 'thread.reply-by-hash',
  'tracker-write': 'tracker.write-by-hash',
  'container-start': 'container.by-label',
  'container-remove': 'container.by-label',
  'process-start': 'process.alive',
  'copy-create': 'copy.exists',
  'copy-remove': 'copy.exists',
  'ref-delete': 'push.remote-sha',
};

/** Удаление случилось, когда предмета НЕТ; остальные — когда он есть. */
const REMOVALS: ReadonlySet<ActionKind> = new Set([
  'container-remove',
  'copy-remove',
  'ref-delete',
]);

export interface OpenAction {
  actionId: string;
  kind: ActionKind;
  target: string;
  idempotencyHint: string;
  startedAt: number;
  startedSeq: number;
}

export type ReconcileVerdict = 'happened' | 'not-happened' | 'retry' | 'ask';

export interface ReconcileDecision {
  actionId: string;
  verdict: ReconcileVerdict;
  readClass: ReadClassName;
  fact: 'value' | 'absent' | 'unknown';
  reason: string;
  elapsedMs: number;
}

/**
 * Чистое решение сверки по факту. `since` — когда сверка этого действия впервые спросила факт
 * (срок повтора считается от неё, а не от старта действия: ядро могло лежать часами).
 */
export function decideReconcile(
  action: OpenAction,
  fact: Fact<string>,
  now: number,
  since: number,
): ReconcileDecision {
  const readClass = ACTION_READ_CLASS[action.kind];
  const kind = factKind(fact);
  const elapsedMs = Math.max(0, now - since);
  const base = { actionId: action.actionId, readClass, fact: kind, elapsedMs };
  if ('unknown' in fact) {
    const def = READ_CLASSES[readClass];
    const limit = 'retryUntilMs' in def ? def.retryUntilMs : 0;
    if (def.onUnknown === 'retry-until' && elapsedMs < limit) {
      return {
        ...base,
        verdict: 'retry',
        reason: `fact unknown (${fact.unknown}); retry until ${limit} ms`,
      };
    }
    return { ...base, verdict: 'ask', reason: `fact unknown (${fact.unknown}) past ${limit} ms` };
  }
  // Значение — всегда свидетельство самого действия, не наличия предмета: читатель `mr-update`
  // сравнивает хэш заголовка и описания с подсказкой (ревью F-104, решение G10 стадии 6).
  const present = kind === 'value';
  const happened = REMOVALS.has(action.kind) ? !present : present;
  const evidence = 'value' in fact ? `: ${fact.value}` : '';
  return {
    ...base,
    verdict: happened ? 'happened' : 'not-happened',
    reason: `${readClass} ${kind}${evidence}`,
  };
}

/** Читатель факта по действию: значение = найденное свидетельство, `absent` = предмета нет. */
export type ActionFactReader = (action: OpenAction) => Reader<string>;
export type ActionFactReaders = Record<ActionKind, ActionFactReader>;

/** Метка решения `retry`, записанного по ответу человека «повторить сверку» (точка 4). */
export const HUMAN_RECHECK = 'human-recheck';

/**
 * Время первой записанной сверки каждого действия (`decision` класса `reconcile`). Ответ человека
 * «повторить сверку» начинает срок заново: иначе срок, истёкший до вопроса, спросил бы снова сразу.
 */
function journaledFirstAsked(task: LiveTask): Map<string, number> {
  const first = new Map<string, number>();
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind !== 'decision') continue;
    const data = line.data as { class?: string; output?: { actionId?: unknown; by?: unknown } };
    const actionId = data.output?.actionId;
    if (data.class !== 'reconcile' || typeof actionId !== 'string') continue;
    if (!first.has(actionId) || data.output?.by === HUMAN_RECHECK) first.set(actionId, line.at);
  }
  return first;
}

export type ReconcileAnswerOutcome = 'done' | 'not-done' | 'recheck' | 'unmatched' | 'settled';

/**
 * Ответ человека на вопрос сверки (точка 4). Вариант узнаётся по ключу среди подписей ВСЕХ языков
 * (`next/answers.ts`): вопрос, заданный по-русски до перевода, и ответ, записанный тогда, ведут к
 * тому же исходу у задачи любого языка и после перезапуска ядра. «Выполнено» — `action.done`,
 * «не выполнено» — `action.failed`, «повторить» — решение `retry` с меткой человека: свёртка
 * возвращает действие в начатые, сверка (таймер загрузки или следующая загрузка) читает факт
 * снова. Чужой текст исхода не выдумывает; действие уже решено — ответ ничего не меняет.
 */
export function settleReconcileAnswer(
  task: LiveTask,
  input: { actionId: string; answer: string; cause: number },
): ReconcileAnswerOutcome {
  const { actionId, answer, cause } = input;
  const action = Object.hasOwn(task.state.actions, actionId)
    ? task.state.actions[actionId]
    : undefined;
  if (action?.status !== 'awaiting-human') return 'settled';
  const key = answerKey('reconcile', answer);
  if (key === 'done') {
    task.append({
      kind: 'action.done',
      actor: 'core',
      cause,
      data: { actionId, result: { reconciled: true, evidence: 'human answer' } },
    });
    return 'done';
  }
  if (key === 'notDone') {
    task.append({
      kind: 'action.failed',
      actor: 'core',
      cause,
      data: { actionId, code: 'not-happened', detail: 'human answer' },
    });
    return 'not-done';
  }
  if (key !== 'recheck') return 'unmatched';
  task.append({
    kind: 'decision',
    actor: 'core',
    cause,
    data: {
      decisionId: newId(),
      class: 'reconcile',
      inputs: [cause],
      facts: [],
      numbers: {},
      reasons: ['human asked to check again'],
      output: { actionId, verdict: 'retry', by: HUMAN_RECHECK },
    },
  });
  return 'recheck';
}

export async function reconcileTask(
  task: LiveTask,
  readers: ActionFactReaders,
  clock: { now(): number },
  firstAsked: Map<string, number>,
  /** Только эти действия (повтор сверки по таймеру); нет — все начатые и не законченные. */
  only?: ReadonlySet<string>,
): Promise<ReconcileDecision[]> {
  const decisions: ReconcileDecision[] = [];
  let journaled: Map<string, number> | undefined;
  for (const action of openActions(task)) {
    if (only && !only.has(action.actionId)) continue;
    const readClass = ACTION_READ_CLASS[action.kind];
    const fact = await readFact(readClass, readers[action.kind](action));
    const now = clock.now();
    let since = firstAsked.get(action.actionId);
    if (since === undefined) {
      journaled ??= journaledFirstAsked(task);
      since = journaled.get(action.actionId);
    }
    const askedBefore = since !== undefined;
    since ??= now;
    firstAsked.set(action.actionId, since);
    const decision = decideReconcile(action, fact, now, since);
    decisions.push(decision);
    if (decision.verdict === 'retry' && askedBefore) continue;
    const logged = task.append({
      kind: 'decision',
      actor: 'core',
      cause: action.startedSeq,
      data: {
        decisionId: newId(),
        class: 'reconcile',
        inputs: [action.startedSeq],
        facts: [{ readClass, kind: decision.fact }],
        numbers: { elapsedMs: decision.elapsedMs },
        reasons: [decision.reason],
        output: { actionId: action.actionId, verdict: decision.verdict },
      },
    });
    if (decision.verdict === 'happened') {
      task.append({
        kind: 'action.done',
        actor: 'core',
        cause: logged.seq,
        data: {
          actionId: action.actionId,
          result: { reconciled: true, evidence: decision.reason },
        },
      });
      firstAsked.delete(action.actionId);
    } else if (decision.verdict === 'not-happened') {
      task.append({
        kind: 'action.failed',
        actor: 'core',
        cause: logged.seq,
        data: { actionId: action.actionId, code: 'not-happened', detail: decision.reason },
      });
      firstAsked.delete(action.actionId);
    } else if (decision.verdict === 'ask') {
      const lang = askLangOf(task.state);
      task.append({
        kind: 'human.asked',
        actor: 'core',
        cause: logged.seq,
        data: {
          askId: newId(),
          point: 4,
          source: 'reconcile',
          dedupe: action.actionId,
          question: CONDUCTOR_QUESTIONS.reconcile(
            lang,
            action.kind,
            action.target,
            decision.reason,
          ),
          options: optionsOf('reconcile', lang),
          defaultAction: null,
        },
      });
      firstAsked.delete(action.actionId);
    }
  }
  return decisions;
}
