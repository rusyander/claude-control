import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { signalDef } from '../../observer/catalog.ts';
import {
  foldObserver,
  initObserverFold,
  withKeys,
  type ObserverFold,
} from '../../observer/fold.ts';
import { judgeSignal } from '../../observer/judge.ts';
import type { Predicate, PredicateCtx, SignalDef } from '../../observer/observer.types.ts';
import { OBSERVER_PREDICATES } from '../../observer/registry.ts';
import type { ObserverNote } from './observer-wiring.types.ts';
import { observerKeyOf, writeObserverDecision } from './write.ts';

/**
 * Наблюдатель на живой задаче (этап 8, F2): подписчик журнала. При прикреплении свёртка
 * предикатов пересобирается из строк журнала ОДИН раз и ничего не пишет — ключи уже вынесенных
 * решений берутся из строк `decision{class:'observer'}` и из самих вердиктов истории (перезапуск
 * ядра не повторяет сигнал; потерянная в крахе телеметрия даёт недосрабатывание, не двойное).
 * Живая строка → новые вердикты → судья по каталогу → `decision` + `signal{action}`. Свои строки
 * наблюдатель видит после текущей: журнал раздаёт дописанное изнутри подписчика по порядку (R10).
 */

export interface AttachDeps {
  ctx: PredicateCtx;
  note?: ObserverNote;
  /** Предикаты и каталог — для тестов; по умолчанию реестр и каталог ядра. */
  predicates?: readonly Predicate[];
  catalog?: (id: string) => SignalDef | undefined;
  /** Строки журнала для пересборки; по умолчанию файл задачи. */
  history?: (task: LiveTask) => readonly JournalLine[];
}

export interface ObserverAttachment {
  /** Снять подписку; повтор ничего не делает. */
  detach(): void;
  /** Текущая свёртка (для проверок и тика зоны T). */
  fold(): ObserverFold;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function attachObserver(task: LiveTask, deps: AttachDeps): ObserverAttachment {
  const predicates = deps.predicates ?? OBSERVER_PREDICATES;
  const catalog = deps.catalog ?? signalDef;
  const note = deps.note ?? (() => {});
  const history = deps.history ?? ((t: LiveTask) => readJournalLines(t.dir, t.taskId).lines);

  const noteErrors = (errors: string[]): void => {
    for (const reason of errors) note('observer.predicate.failed', { taskId: task.taskId, reason });
  };

  let fold = initObserverFold(predicates);
  let lastSeq = 0;
  const seen: string[] = [];
  for (const line of history(task)) {
    const step = foldObserver(fold, line, deps.ctx, predicates);
    fold = step.state;
    noteErrors(step.errors);
    const key = observerKeyOf(line);
    if (key !== undefined) seen.push(key);
    lastSeq = line.seq;
  }
  fold = withKeys(fold, seen);

  const judge = (line: JournalLine): void => {
    const step = foldObserver(fold, line, deps.ctx, predicates);
    fold = step.state;
    noteErrors(step.errors);
    for (const verdict of step.verdicts) {
      const def = catalog(verdict.signal);
      if (!def) {
        note('observer.signal.unknown', { taskId: task.taskId, signal: verdict.signal });
        continue;
      }
      const decision = judgeSignal(verdict, def);
      if (!decision.fired) continue;
      try {
        const where = { stepId: line.stepId, sessionId: line.sessionId, inputs: [line.seq] };
        writeObserverDecision(task, verdict, decision, where);
      } catch (error) {
        // Аренду перехватили: решение вынесет новый владелец по своей пересборке.
        note('observer.write.failed', {
          taskId: task.taskId,
          signal: verdict.signal,
          reason: reasonOf(error),
        });
      }
    }
  };

  const off = task.subscribe((line) => {
    // Строка, уже свёрнутая пересборкой, второй раз не судится.
    if (line.seq <= lastSeq) return;
    lastSeq = line.seq;
    judge(line);
  });
  let attached = true;
  return {
    detach() {
      if (!attached) return;
      attached = false;
      off();
    },
    fold: () => fold,
  };
}
