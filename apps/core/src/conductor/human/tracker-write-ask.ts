import type { LiveTask } from '../../journal/resume.ts';
import { answerKey, askLangOf, labelOf, optionsOf } from '../next/answers.ts';
import { latestTrackerWriteAsks, trackerWriteDedupe } from '../next/tracker-write.ts';
import type { HumanLedger, RaiseOutcome } from './human.types.ts';
import { raiseHumanPoint } from './raise.ts';

/**
 * Вопрос пункта 9 о комментарии назад в тикет (этап 12, P166, W2-D) — подъём и чтение ответа.
 *
 * Отпускает запись только «разрешить» человека из панели или с телефона (подпись устройства).
 * Почему не Telegram: аккаунт владельца достижим с этой машины, а запись в трекер выходит за копию
 * задачи и не кончается MR, который сливает человек (08e §Authority, D29). Отказ — сужение, его
 * принимает любой канал. Модель вопрос не закрывает вовсе: команда с токеном сессии отклонена
 * судом полномочий (`forged-authority`) раньше, чем дойдёт сюда.
 */

const RELEASING_CHANNELS: ReadonlySet<string> = new Set(['panel', 'device']);

export type TrackerWriteApproval =
  { state: 'none' | 'open' | 'approved' | 'declined' } | { state: 'untrusted'; channel: string };

/** Ответ на последний вопрос ключа: не поздний, последний по порядку. */
export function trackerWriteApproval(
  ledger: Pick<HumanLedger, 'asks'>,
  key: string,
  unitId: string,
): TrackerWriteApproval {
  const ask = latestTrackerWriteAsks(ledger.asks).get(trackerWriteDedupe(key, unitId));
  if (!ask) return { state: 'none' };
  if (ask.state === 'open') return { state: 'open' };
  const said = ask.answers.filter((a) => !a.late).at(-1);
  // Истёк или отозван без ответа — вопроса как не было: спросить снова.
  if (!said) return { state: 'none' };
  // Свой текст вместо варианта — не «разрешить»: запись не идёт (сужение по умолчанию).
  if (answerKey('trackerWrite', said.text) !== 'approve') return { state: 'declined' };
  if (!RELEASING_CHANNELS.has(said.channel)) return { state: 'untrusted', channel: said.channel };
  return { state: 'approved' };
}

/** Блокирующий вопрос уровня задачи; открытый с тем же ключом — тот же (`duplicate`). */
export function raiseTrackerWriteAsk(
  task: LiveTask,
  target: { system: string; key: string },
  mr: { unitId: string; url: string },
): RaiseOutcome {
  const lang = askLangOf(task.state);
  const question =
    lang === 'en'
      ? `Write one line with the MR link ${mr.url} into ticket ${target.key} (${target.system})? Only an answer from the panel or the phone releases it.`
      : `Записать в тикет ${target.key} (${target.system}) одну строку со ссылкой на MR ${mr.url}? Запись отпускает только ответ из панели или с телефона.`;
  return raiseHumanPoint(task, {
    source: 'tracker-write',
    point: 9,
    blocking: true,
    stepId: null,
    sessionId: null,
    action: { kind: 'tracker-write', target: target.key },
    dedupe: trackerWriteDedupe(target.key, mr.unitId),
    question,
    options: optionsOf('trackerWrite', lang),
    recommendation: labelOf('trackerWrite', lang, 'approve'),
  });
}
