import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { localizeText, matchText } from '../../lib/server-texts/server-texts.ts';

/**
 * «Продолжить» человека в строке группы (владелец, 05.10.2026) — группе, которая
 * остановилась недоделанной: сдалась на сбое (живой прогон: доступ CLI кончился,
 * повторы исчерпаны, и строка осталась без единой кнопки) или кончила ход без
 * вердикта ревью. Задание одно на все причины — восстановить состояние по фактам
 * и доделать до конца. Отдельно от `split-recheck.ts`: конвейер зовёт это сам, а
 * перепроверка зовёт конвейер — в одном модуле был цикл импортов.
 */

/**
 * Задание группе, остановившейся недоделанной. Причина — английской стороной текста.
 * `gaps` — напоминание с пробелами последней сверки доставки (живой прогон 25.10,
 * g0 d9869abf): причина, обрезанная до 300 знаков, несла конфликт и обрывок «чужих
 * −», а живые сита, пробелы блока «Тесты» и метка «not checked:» до группы не
 * доходили — круг уходил на лишнее напоминание. С пробелами причина-сбой доставки
 * не повторяется обрывком: напоминание несёт их полностью вместе с правилами.
 */
export function continuePrompt(input: {
  branch: string;
  deliver: boolean;
  error?: string;
  gaps?: readonly string[];
}): string {
  const gaps = input.gaps ?? [];
  // Шаблон с одним, двумя и тремя пробелами — `split-delivery-incomplete(-2|-3)`.
  const ofDelivery =
    input.error !== undefined &&
    matchText(input.error)?.messageCode?.startsWith('split-delivery-incomplete') === true;
  const cause =
    input.error && !(ofDelivery && gaps.length > 0)
      ? `: ${localizeText(input.error, 'en').slice(0, 300)}`
      : '';
  const restore =
    'First restore the state from the facts: git status, git log, the MR of the branch if there ' +
    'is one, your transcript — what is done and what is not; run the interrupted checks again.';
  if (gaps.length > 0) {
    return [
      `The human asks the group to continue: its work is not finished (the last turn stopped${cause}).`,
      restore,
      `Then close what the last delivery check found on the branch ${input.branch}:`,
      ...gaps,
    ].join('\n');
  }
  return [
    `The human asks the group to continue: its work is not finished (the last turn stopped${cause}).`,
    restore,
    `Then finish the group's tasks on the branch ${input.branch}.` +
      (input.deliver
        ? ' Deliver as agreed: commit, push the branch, open the MR (or update the existing one) ' +
          'and give its link as the last line.'
        : ' Finish with a short summary of what was done.'),
    HUMAN_ONLY_LINE,
  ].join('\n');
}

/**
 * Что группа отдаёт человеку, а что решает сама (решение владельца 23.10:
 * остановка доставки «решение за вами» — не обычный путь). Вопрос человеку —
 * только слияние, удаление (git или вне своей копии), force-push сверх аренды
 * доставки, миграция/DDL/запись в БД и учётные данные, которых нет нигде в
 * проекте — тот же список, что у навыков `prepare-mr` и `ticket-delivery-2`;
 * остальное («системное» тоже) группа чинит или снимает заметкой в MR.
 */
export const HUMAN_ONLY_LINE =
  'Ask the human (a question, not a report) ONLY for: merging into the target branch; a ' +
  'deletion (any git deletion, or anything outside your copy); a force-push beyond the ' +
  "delivery's lease; a DB migration, DDL or data write; credentials that exist nowhere in the " +
  'project. Everything else — a live check that cannot run here, a red that predates the ' +
  'branch, a missing MR, a stale stand session, a conflict — you resolve yourself, or waive ' +
  'with the reason as a note in the MR description. When one of these does stop you, end the ' +
  'answer with a paragraph of lines `HUMAN: <kind> — <what exactly is needed>`, <kind> being ' +
  'merge, destructive (a deletion, a force-push or a DB write) or credentials: the panel does ' +
  'not answer such a turn for the human, and when it ' +
  'checks the delivery it stops the group on those lines instead of reminding it and shows the ' +
  'human just them.';

/** Что можно только человеку (решение владельца 23.10) — вид строки `HUMAN:`. */
export type HumanAskKind = 'merge' | 'destructive' | 'credentials';

/**
 * Строки `HUMAN: <вид> — <что нужно>` из ПОЛНОГО текста ответа группы
 * (`HUMAN_ONLY_LINE` просит так завершать ответ). Не из хвоста: хвост обрезан
 * до 280 знаков спереди, и длинная строка теряла саму метку, а абзац меток,
 * за которым агент ставил ссылку MR, хвостом не был вовсе. Блоки кода не в
 * счёт (лог с меткой — не просьба). Пункт — до следующей метки или конца
 * строки. Метка — заглавными и отдельным словом (F-41): «The human: merge it…»
 * в прозе — не просьба; эхо шаблона (`merge|destructive|…`, `<что нужно>`) — тоже.
 */
export function humanAsksOf(text: string | undefined): { kind: HumanAskKind; what: string }[] {
  if (!text) return [];
  const asks: { kind: HumanAskKind; what: string }[] = [];
  const marker =
    /(?<![\p{L}\d_])HUMAN:\s*([Mm]erge|[Dd]estructive|[Cc]redentials)\b(?!\s*\|)[ \t]*[—–:-]?[ \t]*(.*?)`?(?=`?(?<![\p{L}\d_])HUMAN:|$)/gu;
  const lines = text.replace(/```[\s\S]*?(```|$)/g, '').split(/\r?\n|\r/);
  for (const match of lines.flatMap((line) => [...line.matchAll(marker)])) {
    const kind = (match[1] ?? '').toLowerCase() as HumanAskKind;
    const what = (match[2] ?? '')
      .replace(/\s+/g, ' ')
      .replace(/[`\s]+$/, '')
      .trim();
    if (what && !/^<[^>]*>/.test(what)) asks.push({ kind, what });
  }
  return asks;
}

/**
 * Вводная группе, чей разговор продолжить нельзя: файла сессии на диске нет
 * (удалён мимо панели — вопрос ревью Q2). Ход идёт новым разговором в той же
 * копии, и без этой вводной агент не знал бы ни ветки, ни своих задач.
 */
export function lostConversationBrief(
  group: Pick<SplitPlanGroupRecord, 'branch' | 'mr'>,
  tasks: readonly string[],
): string {
  return [
    'The panel could not continue your previous conversation in this folder: its transcript is ' +
      'gone (deleted outside the panel). This is a new conversation — restore the context from ' +
      `the facts: git status, git log of the branch ${group.branch}` +
      (group.mr ? `, the MR ${group.mr}.` : '.'),
    ...(tasks.length > 0 ? [GROUP_TASKS_HEADER, ...tasks.map((task) => `- ${task}`)] : []),
  ].join('\n');
}

/** Заголовок списка задач группы во вводных нового разговора. */
export const GROUP_TASKS_HEADER = "The group's tasks:";

/** Первая строка вводной нового разговора вместо остывшего — общая для всех стадий. */
export const COLD_RESUME_INTRO =
  'The panel started a new conversation instead of continuing the previous one: it stood idle ' +
  'past its prompt cache lifetime, and continuing would have written the whole window again at ' +
  'full price. The panel collected the facts below from your copy — start from them.';

/**
 * Первая строка вводной нового разговора для слова доставленной группе (N4,
 * g5 25.10): наблюдатель MR передал красный конвейер или ветки ревьюера, и слово
 * полное само по себе — окно доставки ему не нужно.
 */
export const RELAY_FRESH_INTRO =
  'The panel started a new conversation for this word about your delivered MR: the previous ' +
  'conversation carried the whole delivery, and re-reading that window on every request costs ' +
  'more than this brief. The facts below come from your copy; the word after them says what to ' +
  'do. Your notebook and the previous transcript are there if you need history.';

/**
 * Вводная группе, чей разговор панель НЕ продолжает намеренно (`coldResume`):
 * кэш остыл, и продолжение заново записало бы всё окно. Факты (заметки, git,
 * последний ответ, путь к транскрипту) дописывает запуск — он знает копию и файл.
 */
export function coldResumeBrief(
  group: Pick<SplitPlanGroupRecord, 'branch' | 'mr'>,
  tasks: readonly string[],
  intro: string = COLD_RESUME_INTRO,
): string {
  return [
    intro,
    `Branch ${group.branch}` + (group.mr ? `, MR ${group.mr}.` : '.'),
    ...(tasks.length > 0 ? [GROUP_TASKS_HEADER, ...tasks.map((task) => `- ${task}`)] : []),
  ].join('\n');
}

/** Группа, которой «Продолжить» по делу: остановилась недоделанной и есть где продолжать. */
export function continuable(record: SplitPlanRecord, group: SplitPlanGroupRecord): boolean {
  if (record.cancelledAt || !group.chatId || !group.path || group.cleaned) return false;
  // «Убрать» — без возврата (ревью R3).
  if (group.droppedAt) return false;
  return (
    group.status === 'failed' ||
    (group.status === 'awaiting' && group.waitingFor === 'review-missing') ||
    // Ждёт повтора доставки панелью (до `DELIVERY_RETRY_MS`) — человек может
    // не ждать срока; слово снимает и счёт повторов (`continueGroup`).
    (group.status === 'awaiting' &&
      group.waitingFor === 'delivery' &&
      Boolean(group.deliveryRetry?.at))
  );
}
