import type { UsageLimits } from '@agentdeck/contracts';
import { placeOf } from './compose.ts';
import { escapeHtml } from './html.ts';

/**
 * Команды бота владельцу: `/status` — что работает и что ждёт, `/waiting` —
 * прислать всё ждущее сейчас, `/help` — подсказка. `/task <текст>` (этап 12, P193)
 * в `KNOWN` не входит: разбор отдаёт `'other'`, и его берёт крючок уведомлений
 * ядра (`telegram-notices/press.ts`) — запись во «Входящие». Тексты — как у остальных
 * сообщений ответов, по-русски; только приветствие подключения идёт на языке
 * панели (его читают сразу после нажатия в карточке).
 *
 * Содержимого разговоров здесь нет: проект, имя чата и минуты.
 */

export type BotCommand = 'status' | 'waiting' | 'help' | 'start' | 'clear';

const KNOWN: readonly BotCommand[] = ['status', 'waiting', 'help', 'start', 'clear'];

/** Команда из текста (`/status`, `/status@my_bot`); не команда — `undefined`. */
export function parseCommand(text: string | undefined): BotCommand | 'other' | undefined {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text?.trim() ?? '');
  if (!match) return undefined;
  const name = match[1]!.toLowerCase() as BotCommand;
  return KNOWN.includes(name) ? name : 'other';
}

/** Меню команд бота — `setMyCommands` по-английски и по-русски. */
export const BOT_COMMANDS = {
  en: [
    { command: 'status', description: 'What is running and what waits for you' },
    { command: 'waiting', description: 'Send everything that waits for an answer now' },
    { command: 'task', description: 'Put a task into the board inbox: /task fix login' },
    { command: 'clear', description: 'Remove bot messages (except pending)' },
    { command: 'help', description: 'Commands' },
  ],
  ru: [
    { command: 'status', description: 'Что работает и что ждёт тебя' },
    { command: 'waiting', description: 'Прислать всё, что ждёт ответа, сейчас' },
    { command: 'task', description: 'Записать задачу во «Входящие» доски: /task исправить вход' },
    { command: 'clear', description: 'Убрать сообщения бота (кроме ждущих)' },
    { command: 'help', description: 'Команды' },
  ],
} as const;

export const HELP_TEXT = [
  'Команды:',
  '/status — что работает и что ждёт тебя',
  '/waiting — прислать всё, что ждёт ответа, сейчас',
  '/task текст — записать задачу во «Входящие» доски (запускать — кнопкой «В работу»)',
  '/clear — убрать сообщения бота, кроме ждущих ответа',
  '/help — эта подсказка',
  '',
  'Вопросы и разрешения агентов приходят сюда сами, с кнопками.',
  'Задачи ядра сообщают о конце, открытом MR, падении и ожидании окна — тоже с кнопками.',
].join('\n');

export const ALREADY_CONNECTED = `✅ Уже подключено к AgentDeck.\n\n${HELP_TEXT}`;
export const NOTHING_WAITING = '✅ Ничего не ждёт ответа.';

/** Приветствие после подтверждения в панели — на языке панели. */
export function connectedText(language: 'ru' | 'en'): string {
  return language === 'en'
    ? [
        '✅ Connected to AgentDeck.',
        'Agent questions and permission requests arrive here with buttons, run failures too.',
        '',
        'Commands: /status, /waiting, /task, /help',
      ].join('\n')
    : [
        '✅ Подключено к AgentDeck.',
        'Сюда придут вопросы и разрешения агентов с кнопками и сообщения о сбоях прогонов.',
        '',
        'Команды: /status, /waiting, /task, /help',
      ].join('\n');
}

/** Идущий разговор для `/status`. */
export interface RunningChat {
  project: string;
  title?: string;
  /** Начало хода, мс эпохи. */
  startedAt: number;
}

/** Загрузка окон подписки в процентах; неизвестное окно — без числа. */
export interface LimitShares {
  session?: number;
  week?: number;
}

/** Окна подписки из ответа `GET /api/usage-limits`; окон нет — ничего. */
export function limitSharesOf(limits: UsageLimits | undefined): LimitShares | undefined {
  const windows = limits?.windows ?? [];
  const session = windows.find((window) => window.kind === 'session')?.percent;
  const week = windows.find((window) => window.kind === 'weekly')?.percent;
  if (session === undefined && week === undefined) return undefined;
  return {
    ...(session !== undefined ? { session: Math.round(session) } : {}),
    ...(week !== undefined ? { week: Math.round(week) } : {}),
  };
}

const STATUS_LINES = 15;

export function statusText(input: {
  running: readonly RunningChat[];
  waiting: number;
  limits?: LimitShares;
  now: number;
}): string {
  const lines = [`⚙️ Работают: ${input.running.length}`];
  const sorted = [...input.running].sort((left, right) => left.startedAt - right.startedAt);
  for (const chat of sorted.slice(0, STATUS_LINES)) {
    const minutes = Math.max(0, Math.round((input.now - chat.startedAt) / 60_000));
    // Тот же вид, что в первой строке сообщений: «📁 проект · сессия». Ключ в
    // имени чата закрыт маской до обрезки, иначе обрезка разрезала бы ключ.
    const place = placeOf(chat.title ?? '', chat.project) || escapeHtml('Домашний чат');
    lines.push(`• ${place} · ${minutes} мин`);
  }
  if (sorted.length > STATUS_LINES) lines.push(`…и ещё ${sorted.length - STATUS_LINES}`);
  lines.push(`⏳ Ждут тебя: ${input.waiting}`);
  const limits = input.limits;
  if (limits) {
    const parts = [
      limits.session !== undefined ? `сессия ${limits.session}%` : '',
      limits.week !== undefined ? `неделя ${limits.week}%` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(`📈 ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}
