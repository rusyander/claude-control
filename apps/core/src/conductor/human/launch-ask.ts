import type { LiveTask } from '../../journal/resume.ts';
import { humanChannel } from './channel.ts';
import { readHumanLedger } from './ledger.ts';

/**
 * Пункт 10 (подтвердить деление и запуск) закрывается запуском задачи, а не висит открытым
 * вопросом при бегущей задаче: карточка человека, отчёт и уход за вопросами (напоминания) иначе
 * говорили бы о решении, которое уже принято.
 *
 * - Запуск командой человека (`approve-split` или `launch` — неявное утверждение последнего
 *   деления) по ТОМУ делению, о котором вопрос, — это ответ на вопрос: переход `answer` и
 *   `human.answered` с каналом из доказательства команды.
 * - Вопрос о прежнем делении (человек правил деление, запущено другое) или запуск без команды
 *   (`auto`) — вопрос снят: ответа человека на него не было.
 *
 * Только открытые вопросы — повтор после краха ничего не пишет второй раз.
 */

export const LAUNCH_POINT = 10;
export const LAUNCH_ANSWER = 'approve-split';

export function closeLaunchAsks(
  task: LiveTask,
  launch: { splitId: string | null; cmdId?: string },
): { answered: string[]; withdrawn: string[] } {
  const out = { answered: [] as string[], withdrawn: [] as string[] };
  const ledger = readHumanLedger(task);
  const byHuman = launch.cmdId !== undefined && task.state.commands[launch.cmdId] !== undefined;
  for (const ask of Object.values(ledger.asks)) {
    if (ask.point !== LAUNCH_POINT || ask.state !== 'open') continue;
    if (byHuman && launch.splitId !== null && ask.dedupe === `split:${launch.splitId}`) {
      const cmdId = launch.cmdId as string;
      const who = humanChannel(task, cmdId);
      task.append({
        kind: 'ask.transition',
        actor: who.actor,
        cmdId,
        data: { askId: ask.askId, event: 'answer', from: 'open', to: 'answered' },
      });
      task.append({
        kind: 'human.answered',
        actor: who.actor,
        cmdId,
        data: { askId: ask.askId, answer: LAUNCH_ANSWER, channel: who.channel },
      });
      out.answered.push(ask.askId);
      continue;
    }
    task.append({
      kind: 'ask.transition',
      actor: 'core',
      data: { askId: ask.askId, event: 'withdraw', from: 'open', to: 'withdrawn' },
    });
    out.withdrawn.push(ask.askId);
  }
  return out;
}
