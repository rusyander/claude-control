import { nextState, STEP_MACHINE } from '@agentdeck/contracts/core/states';
import { leadConfigOf, settleLeadAnswer } from '../classify/index.ts';
import { humanChannel } from '../human/channel.ts';
import { leadAnswerFits } from '../intake/index.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { answerKey } from '../next/answers.ts';
import { settleReconcileAnswer } from '../reconcile.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Ответ человека на вопрос (06 §Human points, F26, P71). Открытый вопрос — переход `answer` и
 * `human.answered`; блокирующий вопрос отпускает шаг (`answered` → running), если у шага не
 * осталось другого открытого блокирующего вопроса. Истёкший или снятый — поздний ответ: хранится
 * и показывается, шагу доставляется, если тот ещё жив (`conductor/human/deliver.ts`). Ответ
 * применяется ровно раз: второй ответ на тот же вопрос — отказ, а не перезапись.
 */

export const applyAnswer: ApplyCommand = async (task, command, env) => {
  const { askId, answer } = command.fields as { askId: string; answer: string };
  const ledger = readHumanLedger(task);
  const who = humanChannel(task, command.cmdId);
  const ask = ledger.asks[askId];
  if (!ask) return reject(task, command.cmdId, 'unknown-ask', `no ask ${askId} in this task`);
  if (ask.answers.length > 0 || ask.state === 'answered') {
    return reject(task, command.cmdId, 'already-answered', `ask ${askId} is already answered`);
  }
  const open = ask.state === 'open';
  // Вопрос сверки (точка 4) решает судьбу действия: ответ вне вариантов (на любом языке) вопрос
  // закрыл бы, а действие осталось бы ждать человека навсегда — отказ, вопрос остаётся открытым.
  const reconcileOf = open && ask.source === 'reconcile' ? ask.dedupe : null;
  if (reconcileOf !== null && answerKey('reconcile', answer) === undefined) {
    return reject(
      task,
      command.cmdId,
      'unknown-option',
      `answer is none of the reconcile options: ${ask.options.join(' | ')}`,
    );
  }
  // Вопрос карточки или класса ведущего (этап 11): ответ вне вариантов оставил бы оценку ждать.
  if (open && leadAnswerFits(task.taskId, ask.dedupe, answer) === false) {
    return reject(
      task,
      command.cmdId,
      'unknown-option',
      `answer is none of the options: ${ask.options.join(' | ')}`,
    );
  }
  // Истёкший: машина вопроса знает поздний ответ (`expired` → тот же); снятый — нет, там только
  // сам ответ (переход был бы аномалией свёртки).
  if (open || ask.state === 'expired') {
    task.append({
      kind: 'ask.transition',
      actor: who.actor,
      cmdId: command.cmdId,
      stepId: ask.stepId ?? undefined,
      data: { askId, event: 'answer', from: ask.state, to: open ? 'answered' : ask.state },
    });
  }
  const answered = task.append({
    kind: 'human.answered',
    actor: who.actor,
    cmdId: command.cmdId,
    stepId: ask.stepId ?? undefined,
    data: { askId, answer, channel: who.channel },
  });
  let resumed = false;
  const step = ask.stepId ? task.state.steps[ask.stepId] : undefined;
  const otherBlocking = Object.values(ledger.asks).some(
    (a) => a.askId !== askId && a.stepId === ask.stepId && a.blocking && a.state === 'open',
  );
  if (open && ask.blocking && ask.stepId && step && !otherBlocking) {
    const moved = nextState(STEP_MACHINE, step.state, 'answered');
    if (moved.ok) {
      task.append({
        kind: 'step.transition',
        actor: 'core',
        stepId: ask.stepId,
        cause: answered.seq,
        data: { stepId: ask.stepId, event: 'answered', from: step.state, to: moved.to },
      });
      resumed = true;
    }
  }
  const reconcile =
    reconcileOf === null
      ? undefined
      : settleReconcileAnswer(task, { actionId: reconcileOf, answer, cause: answered.seq });
  if (reconcile === 'recheck' && reconcileOf !== null)
    env.reconcile?.()?.recheck(task.taskId, reconcileOf);
  const lead = open
    ? await settleLeadAnswer(
        task,
        { askId, dedupe: ask.dedupe, answer, cause: answered.seq },
        env.split(),
        leadConfigOf(env.layout),
      )
    : undefined;
  return applied(task, command.cmdId, {
    askId,
    late: String(!open),
    resumed: String(resumed),
    ...(reconcile ? { reconcile } : {}),
    ...(lead ? { lead } : {}),
  });
};
