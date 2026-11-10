import type { AuthorityKind } from '@agentdeck/contracts/core/commands';
import type { AskEntry } from '../human/human.types.ts';
import { LAUNCH_POINT } from '../human/launch-ask.ts';
import { answerKey } from '../next/answers.ts';

/**
 * Суд области команды из Telegram (этап 12, D29, P187, critic B3). Полномочия (`decideAuthority`)
 * уже пропустили вид из списка Telegram; здесь — ПОЛЕ этого вида по книге вопросов задачи (сторона
 * ядра: состояние панели его не расширит). Чистая функция: команда и вопросы задачи → да / нет.
 *
 * Почему уже панели: аккаунт владельца достижим с этой машины, а Telegram доказывает только
 * `from.id`. Поэтому из Telegram:
 * - `answer` — только открытому вопросу; открывающий ответ (`grant`/`allow`) точке 3 (служебный
 *   адрес, настоящая БД, чтение исходника адреса) — нет; решающий ответ сверке (`done`/`notDone`,
 *   судьба внешнего действия) — нет; «разрешить» записи в тикет (пункт 9) — нет; сужающие
 *   (`refuse`, `stop`, `wait`, повтор сверки, «не писать») — всегда;
 *   свой текст — только `ask_human`, `blocker`, `scenario-step`, остальным — только варианты;
 * - `approve-split` — только деления, о котором открыт вопрос запуска (`split:<id>`);
 * - `board-move` — только в «работу»;
 * - `inbox-create` — только запись рукой `source: 'telegram'` (`/task <текст>`); записи из поиска
 *   (тикеты произвольного источника) — панель или телефон, иначе сессия протащит чужие тикеты на
 *   доску под видом человека из Telegram;
 * - отмена, доработка, смена модели и CLI — ходы внутри задачи, поле не сужается.
 */

export type TelegramScope = { ok: true } | { ok: false; reason: string };

/** Ответы, которые ОТКРЫВАЮТ вызов на вопросе права (`permit-point.ts` `OPENS`). */
const OPENING_ANSWERS: ReadonlySet<string> = new Set(['grant', 'allow']);
/** Точка 3 вопроса права: служебный адрес, настоящая БД, чтение исходника адреса. */
const SERVICE_ENDPOINT_POINT = 3;
/** Где ядро принимает свой текст вместо варианта. */
const FREE_TEXT_SOURCES: ReadonlySet<AskEntry['source']> = new Set([
  'ask_human',
  'blocker',
  'scenario-step',
]);
/** Ходы внутри задачи, у которых нет поля для сужения. */
const UNSCOPED: ReadonlySet<string> = new Set(['cancel', 'rework', 'set-model', 'set-cli']);

const no = (reason: string): TelegramScope => ({ ok: false, reason });
const yes: TelegramScope = { ok: true };

function answerScope(fields: Record<string, unknown>, asks: Readonly<Record<string, AskEntry>>) {
  const askId = typeof fields.askId === 'string' ? fields.askId : '';
  const answer = typeof fields.answer === 'string' ? fields.answer : '';
  const ask = asks[askId];
  if (!ask) return no(`telegram: no ask ${askId} in this task`);
  if (ask.state !== 'open') return no(`telegram: ask ${askId} is ${ask.state}, not open`);
  if (
    ask.source === 'permit' &&
    ask.point === SERVICE_ENDPOINT_POINT &&
    OPENING_ANSWERS.has(answer)
  )
    return no('telegram: a point-3 opening answer is the panel or the phone only');
  if (ask.source === 'reconcile') {
    const key = answerKey('reconcile', answer);
    if (key === 'done' || key === 'notDone')
      return no('telegram: settling an external action is the panel or the phone only');
  }
  // Пункт 9: запись в тикет выходит за копию задачи и не кончается MR — «разрешить» из Telegram
  // ядро всё равно не отпустит (`tracker-write-ask.ts`), а принятый ответ только переспросил бы.
  if (ask.source === 'tracker-write' && answerKey('trackerWrite', answer) === 'approve')
    return no('telegram: releasing a tracker write is the panel or the phone only');
  if (!ask.options.includes(answer) && !FREE_TEXT_SOURCES.has(ask.source))
    return no(`telegram: ${ask.source} takes one of its options, not free text`);
  return yes;
}

function approveSplitScope(
  fields: Record<string, unknown>,
  asks: Readonly<Record<string, AskEntry>>,
): TelegramScope {
  const splitId = typeof fields.splitId === 'string' ? fields.splitId : '';
  const open = Object.values(asks).some(
    (ask) =>
      ask.point === LAUNCH_POINT && ask.state === 'open' && ask.dedupe === `split:${splitId}`,
  );
  return open ? yes : no(`telegram: no open launch ask for split ${splitId}`);
}

/** Поле команды пира `telegram`; вопросы — книга задачи (`readHumanLedger(task).asks`). */
export function judgeTelegramScope(
  command: { kind: AuthorityKind; fields: unknown },
  asks: Readonly<Record<string, AskEntry>>,
): TelegramScope {
  const fields = (command.fields ?? {}) as Record<string, unknown>;
  if (command.kind === 'answer') return answerScope(fields, asks);
  if (command.kind === 'approve-split') return approveSplitScope(fields, asks);
  if (command.kind === 'board-move') {
    return fields.to === 'work' ? yes : no('telegram: a board move goes to work only');
  }
  if (command.kind === 'inbox-create') {
    return fields.source === 'telegram'
      ? yes
      : no('telegram: an inbox entry from Telegram is a hand entry (source telegram) only');
  }
  if (UNSCOPED.has(command.kind)) return yes;
  return no(`telegram: ${command.kind} is not a Telegram command`);
}
