import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { WindowOffer } from '@agentdeck/contracts/core/window-offer';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { coreTaskLink } from '../core-notice.ts';
import { MESSAGE_LIMIT, PANEL_LINK_HOST, clip, clock } from '../telegram-answers/compose.ts';
import { bold, escapeHtml } from '../telegram-answers/html.ts';

/**
 * Тексты уведомлений о задачах ядра (этап 12, P191–P194). Наружу — имя задачи, вид события и одна
 * строка сути под маской секретов; ни кода, ни путей, ни промпта (решение владельца 25.10.2026).
 * Ссылка в панель — текстом: адрес loopback Telegram кнопкой не принимает и принимать не должен.
 */

/** Номера действий кнопок `n:` в подписи: 0 доработка, 1 стоп, 2 «В работу», 10+i вариант окна i. */
export const ACTION = { rework: 0, stop: 1, work: 2, offer: 10 } as const;

export const LABEL = {
  rework: '🔁 На доработку',
  stop: '⏹ Стоп',
  work: '▶️ В работу',
  mr: '🔀 Открыть MR',
} as const;

export const TITLE_LIMIT = 120;
const REASON_LIMIT = 300;
const ENTRY_LIMIT = 300;
const STATUS_TASKS = 6;

const flat = (text: string): string => maskSecretsInText(text).replace(/\s+/g, ' ').trim();
/** Маска, обрезка, экранирование — динамическое в тексте только так. */
export const safe = (text: string, limit = TITLE_LIMIT): string =>
  escapeHtml(clip(flat(text), limit));

export const titleHtml = (title: string | null | undefined): string =>
  title?.trim() ? `«${safe(title)}»` : 'без названия';

/** Строка-ссылка на задачу в панели — текстом (loopback). */
export function taskLinkLine(taskId: string): string {
  const href = coreTaskLink(taskId, null).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${href}">Открыть задачу в панели →</a>`;
}

/**
 * Адрес MR годится в кнопку-ссылку: только https и не loopback. Адрес стенда на 127.0.0.1 или
 * localhost кнопкой не уходит никогда (P191) — Telegram отбил бы его, а владельцу он чужой.
 */
export function mrButtonUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === PANEL_LINK_HOST ||
    /^127\./.test(host) ||
    host === '::1' ||
    host === '0.0.0.0';
  return loopback ? undefined : parsed.toString();
}

type Mr = NonNullable<TaskView['mrs']>[number];

function mrLine(mr: Mr): string {
  const name = mr.title?.trim() ? ` ${safe(mr.title, TITLE_LIMIT)}` : '';
  // Адрес MR без кнопки (loopback, http) — строкой кода: видно, но не ссылкой наружу.
  const bare = mrButtonUrl(mr.url) ? '' : ` — <code>${safe(mr.url, 200)}</code>`;
  return `🔀 MR !${mr.iid}${name}${bare}`;
}

/** Почему упала: причина последнего упавшего шага — английской прозой ядра, одной строкой. */
export function failureReason(view: TaskView): string | undefined {
  const failed = [...view.steps].reverse().find((step) => step.outcome === 'failed' && step.reason);
  return failed?.reason ?? undefined;
}

export function doneText(title: string | null, taskId: string, mrs: readonly Mr[]): string {
  return [
    bold(`✅ Задача готова — ${titleHtml(title)}`),
    ...mrs.map(mrLine),
    '',
    taskLinkLine(taskId),
  ].join('\n');
}

export function mrText(title: string | null, taskId: string, mr: Mr): string {
  return [bold(`🔀 MR открыт — ${titleHtml(title)}`), mrLine(mr), '', taskLinkLine(taskId)].join(
    '\n',
  );
}

export function failedText(title: string | null, taskId: string, reason?: string): string {
  return [
    bold(`⛔ Задача упала — ${titleHtml(title)}`),
    ...(reason ? [safe(reason, REASON_LIMIT)] : []),
    '',
    taskLinkLine(taskId),
  ].join('\n');
}

export function offerLabel(offer: WindowOffer): string {
  return clip(offer.kind === 'cli' ? `CLI: ${offer.value}` : `Модель: ${offer.value}`, 60);
}

export function windowText(
  title: string | null,
  taskId: string,
  wait: NonNullable<TaskView['windowWait']>,
  offers: readonly WindowOffer[],
): string {
  const reset =
    wait.resetAt !== null
      ? `Окно откроется в ${escapeHtml(clock(wait.resetAt))}`
      : 'Когда откроется окно — неизвестно';
  return [
    bold(`⏳ Ждёт окна — ${titleHtml(title)}`),
    `Маршрут ${safe(wait.routeId, 80)}: ${escapeHtml(wait.verdict)}. ${reset}.`,
    ...(offers.length ? ['Можно перевести задачу кнопкой ниже.'] : []),
    'Перенос чата — в панели.',
    '',
    taskLinkLine(taskId),
  ].join('\n');
}

export function entryText(text: string): string {
  return `📥 Во «Входящих»: ${safe(text, ENTRY_LIMIT)}`;
}

/** Строка сводки тихих часов по виду уведомления. */
export function heldLine(kind: 'done' | 'mr' | 'failed' | 'window', title: string | null): string {
  const head = {
    done: '✅ готова',
    mr: '🔀 MR открыт',
    failed: '⛔ упала',
    window: '⏳ ждёт окна',
  };
  return `${head[kind]} — ${titleHtml(title)}`;
}

/**
 * Сводка тихих часов, разрезанная по пределу сообщения; строка длиннее предела — обрезана.
 * `count` — сколько строк сводки несёт часть: ушедшая часть снимает ровно их (повтор после сбоя
 * или перезапуска не шлёт ушедшее второй раз).
 */
export function digestParts(
  lines: readonly string[],
  limit = MESSAGE_LIMIT,
): { text: string; count: number }[] {
  const parts: { text: string; count: number }[] = [];
  let current = bold(`🌙 Пока было тихо (${lines.length}):`);
  let count = 0;
  for (const raw of lines) {
    const line = raw.length > limit - 10 ? `${raw.slice(0, limit - 11)}…` : raw;
    if (current.length + 1 + line.length > limit) {
      parts.push({ text: current, count });
      current = line;
      count = 1;
    } else {
      current = `${current}\n${line}`;
      count += 1;
    }
  }
  parts.push({ text: current, count });
  return parts;
}

const STATE_RU: Record<string, string> = {
  draft: 'черновик',
  estimating: 'оценка',
  'awaiting-launch': 'ждёт запуска',
  running: 'в работе',
  paused: 'на паузе',
  'waiting-window': 'ждёт окна',
  publishing: 'публикация',
};

/** Строки `/status` о живых задачах ядра (P193); нет живых — ни строки. */
export function statusLinesOf(tasks: readonly TaskListItem[]): string[] {
  const live = tasks.filter((task) => task.ended === null && task.state !== 'draft');
  if (live.length === 0) return [];
  const lines = live
    .slice(0, STATUS_TASKS)
    .map(
      (task) => `• ${titleHtml(task.title)} — ${STATE_RU[task.state] ?? escapeHtml(task.state)}`,
    );
  const more = live.length > STATUS_TASKS ? [`…и ещё ${live.length - STATUS_TASKS}`] : [];
  return ['', bold(`🧠 Задачи ядра: ${live.length}`), ...lines, ...more];
}

/** Итог под уведомлением после нажатия: строка курсивом. */
export const outcomeLine = (text: string): string => `<i>${escapeHtml(text)}</i>`;

export const TEXT = {
  ended: 'Уже закончена',
  stopped: '⏹ Остановлена из Telegram',
  stopReason: 'Остановлено владельцем из Telegram',
  switched: (label: string) => `Переведена: ${label}`,
  stale: 'Кнопка устарела',
  offersGone: 'Варианты окна сменились — откройте задачу в панели',
  reworkPrompt: (title: string | null) =>
    `✍️ Что доработать в ${titleHtml(title)}? Напишите ответом на это сообщение.`,
  reworkPlaceholder: 'Что доработать',
  reworkAsk: 'Ответьте на подсказку',
  reworkTaken: (title: string | null) => `🔁 Доработка принята — ${titleHtml(title)}`,
  reworkEmpty: 'Пустой ответ — напишите, что доработать.',
  noticeHint:
    'Ответ на уведомление не уходит в задачу. Чтобы отправить на доработку, нажмите «🔁 На доработку» и ответьте на подсказку.',
  taskUsage: 'Напишите так: /task исправить вход — запись ляжет во «Входящие» доски.',
  started: (title: string | null) => `▶️ Запущена — ${titleHtml(title)}`,
  queued: '⏸ В очереди — запускатель стартует, когда освободится место',
  rejected: 'Запись снята с доски',
  accepted: 'Принято',
  unreachable: 'Ядро задач не отвечает — попробуйте позже',
  refusedToast: 'Ядро отказало',
  notRecognised: 'ход из Telegram не признан ядром',
  // Подсказка о привязке — только к отказу полномочий (401/403): к отказу по существу задачи
  // («нет удалённого репозитория») она уводила бы владельца чинить то, что не сломано.
  refused: (message: string, binding: boolean) =>
    `Ядро отказало: ${safe(message, REASON_LIMIT)}.${binding ? ' Привязка бота к ядру — в панели: Интеграции → Telegram.' : ''}`,
} as const;
