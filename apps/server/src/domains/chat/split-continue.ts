import type { SplitPlanGroupRecord } from '../../lib/app-store/app-store.types.ts';

/**
 * Тексты бывших групп разделения, которые панель всё ещё узнаёт: строки `HUMAN:` в ответах
 * (`humanAsksOf`) и вводные нового разговора в старых транскриптах (`panel-preamble.ts`).
 * Хаб «Продолжить» группы снят с разделением (этап 10, G14).
 */

/** Что можно только человеку (решение владельца 23.10) — вид строки `HUMAN:`. */
export type HumanAskKind = 'merge' | 'destructive' | 'credentials';

/**
 * Строки `HUMAN: <вид> — <что нужно>` из ПОЛНОГО текста ответа группы
 * (так группы разделения завершали ответ). Не из хвоста: хвост обрезан
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
