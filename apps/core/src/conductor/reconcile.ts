import type { Fact } from '@agentdeck/contracts/core/facts';
import { factKind } from '@agentdeck/contracts/core/facts';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { newId } from '../lib/ids/uuidv7.ts';
import { readFact, type Reader } from '../lib/facts/read-fact.ts';
import { READ_CLASSES, type ReadClassName } from '../lib/facts/read-classes.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
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
  'tracker-write': 'tracker.write-by-hash',
  'container-start': 'container.by-label',
  'container-remove': 'container.by-label',
  'process-start': 'process.alive',
  'copy-create': 'copy.exists',
  'copy-remove': 'copy.exists',
};

/** Удаление случилось, когда предмета НЕТ; остальные — когда он есть. */
const REMOVALS: ReadonlySet<ActionKind> = new Set(['container-remove', 'copy-remove']);

/**
 * Наличие предмета не доказывает действие: MR есть и до обновления (ревью F-104). Есть —
 * спросить человека; нет — обновлять было нечего, действие не случилось.
 */
const PRESENCE_UNPROVEN: ReadonlySet<ActionKind> = new Set(['mr-update']);

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
  const present = kind === 'value';
  if ('value' in fact && PRESENCE_UNPROVEN.has(action.kind)) {
    return {
      ...base,
      verdict: 'ask',
      reason: `${readClass} value: ${fact.value} — presence does not prove ${action.kind}`,
    };
  }
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

/** Заглушка класса будущей фазы: отвечает `unknown`, никогда «нет». */
export function stubReader(phase: number): ActionFactReader {
  return () => () => {
    throw new Error(`reader not built until phase ${phase}`);
  };
}

/** Время первой записанной сверки каждого действия (`decision` класса `reconcile`). */
function journaledFirstAsked(task: LiveTask): Map<string, number> {
  const first = new Map<string, number>();
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind !== 'decision') continue;
    const data = line.data as { class?: string; output?: { actionId?: unknown } };
    const actionId = data.output?.actionId;
    if (data.class !== 'reconcile' || typeof actionId !== 'string') continue;
    if (!first.has(actionId)) first.set(actionId, line.at);
  }
  return first;
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
      task.append({
        kind: 'human.asked',
        actor: 'core',
        cause: logged.seq,
        data: {
          askId: newId(),
          point: 4,
          question: `Не удалось узнать, выполнено ли действие ${action.kind} → ${action.target}: ${decision.reason}`,
          options: ['повторить сверку', 'считать выполненным', 'считать невыполненным'],
          defaultAction: null,
        },
      });
      firstAsked.delete(action.actionId);
    }
  }
  return decisions;
}
