import { deliveryPreamble, environmentPreamble } from '@agentdeck/contracts/task-split';
import {
  deliverStagePrompt,
  fixStagePrompt,
  mergeRequestWorkPreamble,
  reviewLinkPrompt,
  reviewStagePrompt,
  ANSWER_LANGUAGE_LINE,
} from '@agentdeck/contracts/model-cascade';
import {
  buildHandoffPrompt,
  HANDOFF_ROOT_TASK_LINE,
  type HandoffProposal,
} from '@agentdeck/contracts/chat-handoff';
import { planStagePrompt } from '@agentdeck/contracts/split-plan';
import { LEGACY_IDENTITY, LEGACY_LEADING, LEGACY_WHOLE } from './panel-preamble-legacy.ts';

/**
 * Первая строка каждого сообщения, которое панель сама шлёт в чат группы
 * (журнал 98): ветка и ключи задач. Сторож git пускает правку истории своей
 * ветки только по ключу задачи в словах пользователя текущего окна, а в
 * продолжении, заведённом панелью, ключа не было — агент упёрся в отказ и
 * встал с вопросом. Звено и продолжение без ветки к тому же не знают, где они.
 */
export function groupIdentityLine(branch: string, tickets: readonly string[]): string {
  const parts = [branch ? `Group branch: ${branch}.` : ''];
  if (tickets.length > 0) parts.push(`Group tasks: ${tickets.join(', ')}.`);
  return parts.filter(Boolean).join(' ');
}

/**
 * Что в первой реплике чата написала ПАНЕЛЬ, а не человек, — чтобы название
 * чата не бралось из неё (живой стенд 24–25.09.2026: группы назывались
 * «Панель подготовила эту копию: Локальный слой: перенесено 235,…», звенья —
 * «Это новая сессия: работа велась моделью claude-opus…»).
 *
 * Метки в самом тексте у этих преамбул нет: их читает агент, и транскрипты,
 * уже лежащие на диске, её не получили бы. Поэтому начало каждой преамбулы
 * берётся у ТОЙ ЖЕ функции, что её пишет: она зовётся с меткой-заглушкой на
 * месте подстановки, и всё до заглушки в первой строке — неизменное начало.
 * Список фраз здесь не ведётся — поменяют текст преамбулы, поменяется и начало.
 *
 * Два рода преамбул:
 * - вводный абзац перед заданием (копия, доставка, чужой MR, продолжение в
 *   чистой сессии) — выбрасывается абзац, задание остаётся;
 * - задание звена целиком (ревью, правки, доставка, ревью чужого MR) — вся
 *   реплика панельная, названия из неё нет.
 *
 * Строка ветки группы (`groupIdentityLine`) первой строкой — тоже признак
 * реплики панели целиком: её ставит только панель, в каждое своё сообщение чату
 * группы (работа после плана, напоминание, продолжение). Задание после неё
 * собрано из предложения, а не написано человеком, — и чат называется именем
 * группы (живой прогон 25.09.2026: «Ветка группы: fix/capitalize. Панель
 * подготовила эту копию…» в списке и в карточке вопроса у родителя).
 */

const MARK = '⁣panel-preamble-mark⁣';

/**
 * Сколько знаков первой строки хватает, чтобы узнать преамбулу. Строка целиком
 * не годится: её хвост правят, а транскрипты на диске хранят прежний текст
 * (живой прогон 25.09.2026 — абзац доставки дописали про force-push, и чаты
 * групп, заведённые накануне, снова назывались «Доставка до готового MR —…»).
 */
const OPENER_MAX = 60;

/** Неизменное начало первой строки текста: до заглушки и не длиннее `OPENER_MAX`. */
function openerOf(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const at = firstLine.indexOf(MARK);
  return (at >= 0 ? firstLine.slice(0, at) : firstLine).trimStart().slice(0, OPENER_MAX);
}

/** Начала короче этого за преамбулу не считаются: слишком легко совпасть с речью человека. */
const MIN_OPENER = 10;

function openers(texts: string[]): string[] {
  return [...new Set(texts.map(openerOf))].filter((opener) => opener.length >= MIN_OPENER);
}

const HANDOFF: HandoffProposal = { done: MARK, next: MARK, checkpoint: MARK };

const LEADING = [
  ...openers([
    environmentPreamble({ mirror: MARK }),
    environmentPreamble({}),
    deliveryPreamble({ branch: MARK }),
    mergeRequestWorkPreamble({ url: MARK }),
    buildHandoffPrompt(HANDOFF),
  ]),
  ...LEGACY_LEADING,
];

const WHOLE = [
  ...LEGACY_WHOLE,
  ...openers([
    planStagePrompt({ title: MARK, task: MARK, branch: MARK }),
    planStagePrompt({ title: MARK, task: MARK }),
    reviewStagePrompt({ task: MARK, model: MARK, branch: MARK }),
    reviewStagePrompt({ task: MARK }),
    fixStagePrompt([MARK], { branch: MARK }),
    fixStagePrompt([MARK]),
    deliverStagePrompt({ branch: MARK, after: 'fix' }),
    deliverStagePrompt({ branch: MARK, after: 'review' }),
    deliverStagePrompt({ after: 'review' }),
    deliverStagePrompt({ branch: MARK, after: 'work' }),
    deliverStagePrompt({ after: 'work' }),
    reviewLinkPrompt({ url: MARK }),
    // Продолжение группы в чистой сессии: задание группы в нём — цитата из
    // предложения, своих слов человека там нет.
    buildHandoffPrompt(HANDOFF, MARK, { group: true }),
  ]),
];

/** Начала строки ветки группы: с веткой и без неё (одни ключи задач). */
const IDENTITY = [
  ...openers([groupIdentityLine(MARK, []), groupIdentityLine('', [MARK])]),
  ...LEGACY_IDENTITY,
];

const startsWithAny = (line: string, list: readonly string[]): boolean => {
  const bare = line.trimStart();
  return list.some((opener) => bare.startsWith(opener));
};

/**
 * Текст реплики без преамбул панели. Реплика — задание звена целиком → пусто.
 * Иначе снимаются вводные абзацы панели в начале; всё, что после первого
 * абзаца человека или задания, остаётся как есть.
 */
export function withoutPanelPreamble(text: string): string {
  const lines = text.split('\n');
  if (startsWithAny(lines.find((line) => line.trim()) ?? '', IDENTITY)) return '';
  if (lines.some((line) => startsWithAny(line, WHOLE))) return '';
  const paragraphs = withoutPanelTail(text).split(/\n[ \t]*\n/);
  let first = 0;
  while (first < paragraphs.length && startsWithAny(paragraphs[first] ?? '', LEADING)) first += 1;
  return paragraphs.slice(first).join('\n\n');
}

/**
 * Хвост панели после слов задания. Строка языка ответа приписана к заданиям
 * модели по-английски (решение владельца D-E) и в названии чата стояла бы
 * английской фразой; справка об исходном задании продолжения — тоже: название
 * продолжения — что делать дальше, а не пересказ всей работы.
 */
function withoutPanelTail(text: string): string {
  const at = text.indexOf(`\n${HANDOFF_ROOT_TASK_LINE}`);
  const head = at >= 0 ? text.slice(0, at) : text;
  return head
    .split(/\n[ \t]*\n/)
    .filter((paragraph) => paragraph.trim() !== ANSWER_LANGUAGE_LINE)
    .join('\n\n');
}
