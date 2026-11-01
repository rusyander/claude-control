import { basename } from 'node:path';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { headLine, panelLink, placeOf, withLink } from './telegram-answers/compose.ts';
import { bold, escapeHtml, expandable } from './telegram-answers/html.ts';
import type { TurnEnd } from './turn-end/turn-end.types.ts';

/**
 * Текст уведомления в Telegram о прогоне. Конец хода — две карточки и только
 * они (решение владельца 30.10.2026):
 *
 *   <b>✅ Задача закрыта · 📁 shop · Аудит проекта</b>
 *   Аудит закончен: 12 находок исправлены, MR !12 открыт.
 *   шёл 42 мин
 *
 *   <a href="http://127.0.0.1:8888/chat?id=…">Открыть чат →</a>
 *
 *   <b>⏳ Агент ждёт вас · 📁 shop · VS Code · Аудит проекта</b>
 *   <b>Нужно решить:</b> Опубликовать замечания тредами в MR?
 *   1. Да
 *   2. Нет
 *   шёл 42 мин
 *
 *   <a href="…">Открыть чат →</a>
 *
 * Первая строка — вид, проект за меткой «📁» и сессия (чужой CLI или «VS Code» —
 * между ними), ссылка — последней. Из ответа агента — только одна-две фразы
 * итога или то, что решить (`turn-end/`), под маской секретов, пути свёрнуты до
 * имени файла. Промежуточный конец хода сюда не доходит вовсе (`telegram.ts`).
 * Вопрос и разрешение посреди хода — тот же вид «Агент ждёт вас»; у ошибки —
 * только класс в свёрнутой цитате.
 *
 * Только для Telegram: вебхук и push шлют прежнюю строку (`compose`).
 */

/** Что знает о прогоне его уведомление — ровно поля, которые идут в текст. */
export interface RichNotice {
  kind: 'done' | 'error' | 'permission' | 'question' | 'testFailed' | string;
  chatId?: string;
  projectPath?: string;
  toolName?: string;
  question?: string;
  errorText?: string;
  durationMs?: number;
  failed?: number;
  total?: number;
  /** Разбор конца хода — у `done`: закрыта или ждёт. */
  turn?: TurnEnd;
}

/** Вид карточки «закрыта». */
export const CLOSED_TYPE = '✅ Задача закрыта';
/** Вид карточки «ждёт» — и у конца хода, и у вопроса или разрешения посреди него. */
export const WAITING_TYPE = '⏳ Агент ждёт вас';

const QUESTION_LIMIT = 300;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Пути в тексте — до имени файла: `/Users/me/work/shop/src/a.ts` → `…/a.ts`.
 * Путь начинается с корня (`/`, `~/`, `C:\`) и содержит хотя бы два звена.
 */
export function withoutPaths(text: string): string {
  return text.replace(
    /(?<![\w.])(?:[A-Za-z]:[\\/]|~[\\/]|[\\/])(?:[^\s\\/"'«»`]+[\\/])+([^\s\\/"'«»`]*)/g,
    (_match, tail: string) => `…/${tail}`,
  );
}

/**
 * Класс ошибки без подробностей: `TypeError`, `ENOENT`, `overloaded_error`,
 * `HTTP 529`. Подробность (сообщение, стек, пути) наружу не идёт; класса не
 * нашлось — строки нет вовсе.
 */
export function errorClassOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const named = /\b([A-Z][A-Za-z]*Error)\b/.exec(text)?.[1];
  if (named) return named;
  const errno = /\b(E[A-Z]{3,})\b/.exec(text)?.[1];
  if (errno) return errno;
  const snake = /\b([a-z]+(?:_[a-z]+)*_error)\b/.exec(text)?.[1];
  if (snake) return snake;
  const status = /\b(?:HTTP|status|API Error:?)\s*([45]\d\d)\b/i.exec(text)?.[1];
  return status ? `HTTP ${status}` : undefined;
}

/** «12 мин», «1 ч 05 мин». */
export function spanOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

/** Маска секретов, свёртка путей, обрезка, затем экранирование. */
const safe = (text: string, limit = Number.POSITIVE_INFINITY): string =>
  escapeHtml(clip(withoutPaths(maskSecretsInText(text)).replace(/\s+/g, ' ').trim(), limit));

/** Длительность — не суть, а пояснение: обычным шрифтом. */
const spanLine = (notice: RichNotice): string =>
  notice.durationMs === undefined ? '' : `шёл ${spanOf(notice.durationMs)}`;

/** Конец хода: итог закрытой задачи или что решить и из чего выбирать. */
function turnParts(notice: RichNotice, turn: TurnEnd): { type: string; lines: string[] } {
  if (turn.kind === 'waiting') {
    return {
      type: WAITING_TYPE,
      lines: [
        `${bold('Нужно решить:')} ${safe(turn.ask || 'ответ в чате', QUESTION_LIMIT)}`,
        ...turn.options.map((option, index) => `${index + 1}. ${safe(option, 80)}`),
        spanLine(notice),
      ],
    };
  }
  return {
    type: CLOSED_TYPE,
    lines: [turn.kind === 'closed' ? safe(turn.summary, 240) : '', spanLine(notice)],
  };
}

/** Вид первой строкой и строки под ней (уже разметкой). */
function partsOf(notice: RichNotice): { type: string; lines: string[] } {
  switch (notice.kind) {
    case 'done':
      return turnParts(notice, notice.turn ?? { kind: 'closed', summary: '' });
    case 'error':
      return { type: '🛑 ОШИБКА', lines: [bold('Агент упал')] };
    case 'permission':
      return {
        type: WAITING_TYPE,
        lines: [`${bold('Нужно разрешение:')} ${safe(notice.toolName ?? 'инструмент', 200)}`],
      };
    case 'question': {
      const text = withoutPaths(maskSecretsInText(notice.question ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
      const whole =
        text.length > QUESTION_LIMIT ? `${text.slice(0, QUESTION_LIMIT)}…полностью в панели` : text;
      return {
        type: WAITING_TYPE,
        lines: [`${bold('Нужно решить:')} ${escapeHtml(whole || 'вопрос в чате')}`],
      };
    }
    default:
      return {
        type: '🧪 ТЕСТЫ',
        lines: [
          bold(
            notice.total
              ? `${notice.failed ?? 0} из ${notice.total} упали`
              : `Упало: ${notice.failed ?? 0}`,
          ),
        ],
      };
  }
}

/**
 * Имя чата, которое ничего не говорит: «Прогресс по .agent/PROGRESS.md»,
 * «Продолжение по …» — так CLI называет сессию, начатую словами «продолжай по
 * PROGRESS.md» (выборка 28–30.10: все 85 уведомлений вне панели). Такое имя в
 * первую строку не идёт.
 */
export function isContinuationTitle(title: string): boolean {
  return (
    /(продолж|прогресс|continue|progress|resume)/iu.test(title) && /\.md\b|PROGRESS/u.test(title)
  );
}

/** Проект и сессия первой строки: пути в имени чата свёрнуты. */
function placeOfNotice(title: string | undefined, project: string, via?: string): string {
  const named = title && !isContinuationTitle(title) ? withoutPaths(title) : '';
  return placeOf(named, project, via);
}

/**
 * Текст для Telegram разметкой HTML: вид, проект и сессия; суть; у ошибки —
 * класс в свёрнутой цитате; ссылка на чат последней. `undefined` — у события
 * нет своего текста (бюджет, сигнал сторожа собираются в `telegram.ts`).
 * `via` — чужой CLI или «VS Code».
 */
export function composeRich(
  notice: RichNotice,
  title?: string,
  openId?: string,
  via?: string,
): string | undefined {
  if (!['done', 'error', 'permission', 'question', 'testFailed'].includes(notice.kind)) {
    return undefined;
  }
  const project = notice.projectPath ? basename(notice.projectPath) : '';
  const { type, lines: body } = partsOf(notice);
  const errorClass = notice.kind === 'error' ? errorClassOf(notice.errorText) : undefined;
  const chat = openId ?? notice.chatId;
  const lines = [
    headLine(type, placeOfNotice(title, project, via)),
    ...body,
    errorClass ? expandable(escapeHtml(errorClass)) : '',
  ].filter(Boolean);
  return withLink(lines, chat ? panelLink(chat) : undefined).join('\n');
}

/**
 * Сигнал сторожа и бюджет — тем же видом: вид, проект и сессия; что случилось
 * словами; группа, код правила и числа — в свёрнутой цитате; ссылка последней.
 */
export function composeSignal(input: {
  type: string;
  essence: string;
  session?: string;
  project?: string;
  via?: string;
  details?: string;
  openId?: string;
}): string {
  const lines = [
    headLine(input.type, placeOfNotice(input.session, input.project ?? '', input.via)),
    bold(escapeHtml(input.essence)),
    input.details ? expandable(escapeHtml(input.details)) : '',
  ].filter(Boolean);
  return withLink(lines, input.openId ? panelLink(input.openId) : undefined).join('\n');
}

/** Текст первого вопроса вызова `AskUserQuestion` — из его входа. */
export function firstQuestionOf(input: unknown): string | undefined {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions)) return undefined;
  const first = questions[0] as { question?: unknown } | undefined;
  return typeof first?.question === 'string' && first.question.trim()
    ? first.question.trim()
    : undefined;
}

/** Подписи вариантов первого вопроса `AskUserQuestion` — из его входа. */
export function questionOptionsOf(input: unknown): string[] {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  const options = (questions[0] as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (option as { label?: unknown } | null)?.label)
    .filter((label): label is string => typeof label === 'string' && Boolean(label.trim()))
    .map((label) => label.trim());
}
