import { UNIT_MACHINE } from '@agentdeck/contracts/core/states';
import type { LiveTask } from '../../journal/resume.ts';
import type { AskEntry, HumanLedger } from './human.types.ts';
import { ASK_REMINDER } from './ledger.ts';

/**
 * Уход за открытыми вопросами (06 §Human points: напоминания по расписанию, никогда не блок
 * другим единицам). Решение чистое — проекция журнала и время; запись — отдельно.
 * - Шаг вопроса кончился после вопроса → вопрос снят (`withdraw`): спрашивать больше некого.
 *   Вопрос, заданный уже кончившемуся шагу (точка 6), живёт до конца единицы; конец задачи
 *   снимает любой.
 * - Напоминание: 15 мин, 1 ч, 4 ч от вопроса; больше трёх — шум, карточка и так висит.
 * - Неблокирующий вопрос истекает через 24 ч: шаг давно пошёл по умолчанию. Блокирующий не
 *   истекает никогда — молчание человека не ответ (пункты 3–8, 10 ждут).
 */

export const REMIND_AFTER_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000] as const;
export const NONBLOCKING_EXPIRE_MS = 24 * 60 * 60_000;
const UNIT_TERMINAL: ReadonlySet<string> = new Set(UNIT_MACHINE.terminal);

export type AskUpkeep =
  | { kind: 'withdraw'; askId: string; stepId: string | null; reason: string }
  | { kind: 'expire'; askId: string }
  | { kind: 'remind'; askId: string; nth: number };

/** Почему открытый вопрос больше некому задавать; `null` — вопрос живёт. */
function orphaned(ledger: HumanLedger, ask: AskEntry, taskEnded: boolean): string | null {
  // Задача кончилась — открытых вопросов не остаётся: ни у шага, ни без шага (запуск, деление).
  if (taskEnded) return 'task ended';
  const step = ask.stepId ? ledger.steps[ask.stepId] : undefined;
  if (!step || step.endedSeq === null) return null;
  // Шаг кончился, пока вопрос висел, — спрашивать больше некого.
  if (step.endedSeq > ask.askedSeq) return `step ended ${step.state}`;
  // Вопрос задан уже кончившемуся шагу: это точка 6 дирижёра о следующем круге или повторе
  // (02:51) — его ждёт единица, и снимает его только её конец, иначе задача ждёт невидимого.
  const unit = ledger.units[step.unitId]?.state;
  return unit && UNIT_TERMINAL.has(unit) ? `unit ended ${unit}` : null;
}

export function decideAskUpkeep(ledger: HumanLedger, now: number, taskEnded = false): AskUpkeep[] {
  const out: AskUpkeep[] = [];
  for (const ask of Object.values(ledger.asks)) {
    if (ask.state !== 'open') continue;
    const why = orphaned(ledger, ask, taskEnded);
    if (why !== null) {
      out.push({ kind: 'withdraw', askId: ask.askId, stepId: ask.stepId, reason: why });
      continue;
    }
    const age = now - ask.askedAt;
    if (!ask.blocking && age >= NONBLOCKING_EXPIRE_MS) {
      out.push({ kind: 'expire', askId: ask.askId });
      continue;
    }
    // Срок, пройденный после прошлого напоминания; пропущенные (ядро спало) догоняются одним
    // напоминанием, не пачкой. Больше трёх на вопрос не бывает.
    const last = ask.lastReminderAt;
    const fresh = REMIND_AFTER_MS.some(
      (ms) => age >= ms && (last === null || ask.askedAt + ms > last),
    );
    if (fresh && ask.reminders < REMIND_AFTER_MS.length) {
      out.push({ kind: 'remind', askId: ask.askId, nth: ask.reminders + 1 });
    }
  }
  return out;
}

/** Запись решений ухода; проекция правится на месте, чтобы второй вызов в ту же минуту молчал. */
export function applyAskUpkeep(task: LiveTask, ledger: HumanLedger, acts: AskUpkeep[]): void {
  for (const act of acts) {
    const ask = ledger.asks[act.askId];
    if (!ask) continue;
    if (act.kind === 'remind') {
      const line = task.append({
        kind: 'signal',
        actor: 'core',
        stepId: ask.stepId ?? undefined,
        data: {
          signal: ASK_REMINDER,
          severity: ask.blocking ? 'warn' : 'info',
          subject: ask.askId,
          detail: `reminder ${act.nth}: ${ask.question}`.slice(0, 2000),
        },
      });
      ask.reminders = act.nth;
      ask.lastReminderAt = line.at;
      ledger.signals.push({
        signal: ASK_REMINDER,
        severity: ask.blocking ? 'warn' : 'info',
        subject: ask.askId,
        detail: '',
        seq: line.seq,
      });
      continue;
    }
    const event = act.kind === 'withdraw' ? 'withdraw' : 'expire';
    const to = act.kind === 'withdraw' ? 'withdrawn' : 'expired';
    task.append({
      kind: 'ask.transition',
      actor: 'core',
      stepId: ask.stepId ?? undefined,
      data: { askId: ask.askId, event, from: ask.state, to },
    });
    ask.state = to;
  }
}
