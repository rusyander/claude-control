import { basename } from 'node:path';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { headLine, panelLink, placeOf, withLink } from './telegram-answers/compose.ts';
import { bold, escapeHtml, expandable } from './telegram-answers/html.ts';

/**
 * Текст уведомления в Telegram о прогоне (итоговый формат владельца 25.10.2026):
 *
 *   <b>✅ ГОТОВО · 📁 shop · Аудит проекта</b>
 *   шёл 12 мин
 *
 *   <a href="http://127.0.0.1:8888/chat?id=…">Открыть чат →</a>
 *
 * Первая строка — вид, проект за меткой «📁» и сессия (чужой CLI или «VS Code» —
 * между ними), вторая — суть ровно один раз, ссылка — последней. Кода, путей,
 * промпта и ответа агента нет: суть вопроса — под маской секретов, пути
 * свёрнуты до имени файла, у ошибки — только класс в свёрнутой цитате.
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
}

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

/** Вид первой строкой и суть второй (уже разметкой). */
function partsOf(notice: RichNotice): { type: string; essence: string } {
  switch (notice.kind) {
    case 'done':
      // Длительность — не суть, а пояснение: обычным шрифтом.
      return {
        type: '✅ ГОТОВО',
        essence: notice.durationMs === undefined ? '' : `шёл ${spanOf(notice.durationMs)}`,
      };
    case 'error':
      return { type: '🛑 ОШИБКА', essence: bold('Агент упал') };
    case 'permission':
      return {
        type: '🔐 РАЗРЕШЕНИЕ',
        essence: bold(safe(notice.toolName ?? 'Нужно разрешение', 200)),
      };
    case 'question': {
      const text = withoutPaths(maskSecretsInText(notice.question ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
      const whole =
        text.length > QUESTION_LIMIT ? `${text.slice(0, QUESTION_LIMIT)}…полностью в панели` : text;
      return { type: '❓ ВОПРОС', essence: bold(escapeHtml(whole || 'Агент задал вопрос')) };
    }
    default:
      return {
        type: '🧪 ТЕСТЫ',
        essence: bold(
          notice.total
            ? `${notice.failed ?? 0} из ${notice.total} упали`
            : `Упало: ${notice.failed ?? 0}`,
        ),
      };
  }
}

/** Проект и сессия первой строки: пути в имени чата свёрнуты. */
function placeOfNotice(title: string | undefined, project: string, via?: string): string {
  return placeOf(title ? withoutPaths(title) : '', project, via);
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
  const { type, essence } = partsOf(notice);
  const errorClass = notice.kind === 'error' ? errorClassOf(notice.errorText) : undefined;
  const chat = openId ?? notice.chatId;
  const lines = [
    headLine(type, placeOfNotice(title, project, via)),
    essence,
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
