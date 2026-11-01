import { STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { LiveTask } from '../../journal/resume.ts';
import type { Outgoing } from '../run/run.types.ts';
import type { HumanLedger } from './human.types.ts';

/**
 * Доставка человека в сессию шага на границе хода (02 §User interventions, F26): сообщения шагу,
 * ответы и поздние ответы — каждый ровно раз. Что уже доставлено, знает журнал
 * (`message.delivered` по id ссылки); исполнитель пишет эту строку ПОСЛЕ отправки
 * (`recordDelivery`): крах ровно между отправкой и строкой даёт один повтор, а не потерю — потеря
 * слова человека хуже лишней копии.
 *
 * Метка платформы стоит первой строкой: модель отличает слово человека от вывода инструмента и
 * текста файла (подделать её изнутри файла нельзя — инструменты сообщение не пишут).
 */

export const HUMAN_MARK = '[agentdeck · human-origin]';

function marked(head: string, body: string): string {
  return `${HUMAN_MARK} ${head}\n${body}`;
}

/** Ждущие доставки этому шагу, в порядке журнала. Чисто: на входе только проекция журнала. */
export function pendingDeliveries(ledger: HumanLedger, stepId: string): Outgoing[] {
  const step = ledger.steps[stepId];
  if (!step || (STEP_MACHINE.terminal as readonly string[]).includes(step.state)) return [];
  const out: { seq: number; item: Outgoing }[] = [];
  for (const m of Object.values(ledger.messages)) {
    if (m.stepId !== stepId || ledger.deliveries[m.cmdId]) continue;
    out.push({
      seq: m.seq,
      item: {
        text: marked('Message from the human to this step:', m.text),
        ref: { kind: 'message', id: m.cmdId },
      },
    });
  }
  for (const ask of Object.values(ledger.asks)) {
    if (ask.stepId !== stepId) continue;
    const first = ask.answers[0];
    if (!first) continue;
    // Поздний ответ ссылается на вопрос (ответ после срока один), в срок — на команду ответа.
    const ref: Outgoing['ref'] = first.late
      ? { kind: 'late-answer', id: ask.askId }
      : { kind: 'answer', id: first.cmdId ?? ask.askId };
    if (ledger.deliveries[ref.id]) continue;
    const head = first.late
      ? `Late answer (the question had ${ask.state === 'withdrawn' ? 'been withdrawn' : 'expired'}; use it only if it still applies) to «${ask.question}»:`
      : `The human answered «${ask.question}»:`;
    out.push({ seq: first.seq, item: { text: marked(head, first.text), ref } });
  }
  return out.sort((a, b) => a.seq - b.seq).map((o) => o.item);
}

/**
 * Строка доставки — после отправки, один раз на ссылку (F26). Напоминание — не доставка слова
 * человека, строки у него нет (его считает `ask-reminder`). Пакет подсказок наблюдателя (`hint`,
 * этап 8 F8) строку получает: она снимает его подсказки в свёртке, и перезапуск их не повторит.
 */
export function recordDelivery(
  task: LiveTask,
  ledger: HumanLedger,
  at: { stepId: string; sessionId: string },
  ref: Outgoing['ref'],
): boolean {
  if (ref.kind === 'reminder' || ledger.deliveries[ref.id]) return false;
  const line = task.append({
    kind: 'message.delivered',
    actor: 'core',
    stepId: at.stepId,
    sessionId: at.sessionId,
    data: { stepId: at.stepId, sessionId: at.sessionId, ref: { kind: ref.kind, id: ref.id } },
  });
  ledger.deliveries[ref.id] = { stepId: at.stepId, seq: line.seq };
  return true;
}
