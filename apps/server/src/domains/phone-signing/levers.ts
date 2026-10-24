import { PERMISSION_RULE_IDS, resolvePermissionRules } from '@agentdeck/contracts/permission-rules';
import {
  GROUP_REQUEST_DEFAULTS,
  pickGroupPermissions,
  type GroupPermissionLevel,
  type GroupRequestId,
} from '@agentdeck/contracts/split-groups';

/**
 * Рычаги — настройки, которые ослабляют права ВСЕХ будущих решений разом:
 * глобальный авторежим чатов, правила автоподтверждения, строки разрешений
 * групп. При включённом режиме подписи их ослабление отклоняется с любого
 * канала: телефон их не шлёт, а окно, которое могла переписать правка
 * фронтенда, доказать ничего не может. Ужесточение и всё, что прав не
 * касается, проходит как раньше.
 *
 * Функции чистые: текущее положение приходит аргументом, по нему и судится
 * «ослабляет ли».
 */

const RANK: Record<GroupPermissionLevel, number> = { auto: 0, notify: 1, human: 2 };

/** Хоть одна строка стала свободнее, чем была. */
export function groupLevelsLoosen(
  current: Readonly<Partial<Record<GroupRequestId, GroupPermissionLevel>>>,
  next: Readonly<Partial<Record<GroupRequestId, GroupPermissionLevel>>>,
): boolean {
  return (Object.keys(GROUP_REQUEST_DEFAULTS) as GroupRequestId[]).some((id) => {
    const was = current[id] ?? GROUP_REQUEST_DEFAULTS[id];
    const now = next[id] ?? GROUP_REQUEST_DEFAULTS[id];
    return RANK[now] < RANK[was];
  });
}

export interface SettingsLeverState {
  chatAutoMode: boolean;
  autoApproveRules: Record<string, boolean> | undefined;
}

/**
 * `PATCH /api/settings`. Правила автоподтверждения сверяются в обоих прочтениях
 * патча — заменой (так их пишет хранилище) и слиянием: какое бы ни сработало,
 * включившееся правило заметно.
 */
export function settingsPatchLoosens(current: SettingsLeverState, patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const body = patch as Record<string, unknown>;
  if (body.chatAutoMode === true && current.chatAutoMode !== true) return true;
  const rules = body.autoApproveRules;
  if (rules && typeof rules === 'object') {
    const was = resolvePermissionRules(current.autoApproveRules);
    const replaced = resolvePermissionRules(rules as Record<string, boolean>);
    const merged = resolvePermissionRules({
      ...current.autoApproveRules,
      ...(rules as Record<string, boolean>),
    });
    if (PERMISSION_RULE_IDS.some((id) => !was[id] && (replaced[id] || merged[id]))) return true;
  }
  return false;
}

/**
 * `PUT /api/split-defaults`: маршрут кладёт строки поверх КОРОБКИ, поэтому и
 * сравниваются строки тела поверх коробки с действующими общими.
 */
export function splitDefaultsLoosen(
  current: Readonly<Record<GroupRequestId, GroupPermissionLevel>>,
  body: unknown,
  builtIn: Readonly<Record<GroupRequestId, GroupPermissionLevel>>,
): boolean {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const own =
    raw.permissions && typeof raw.permissions === 'object'
      ? pickGroupPermissions(raw.permissions as Record<string, unknown>)
      : {};
  return groupLevelsLoosen(current, { ...builtIn, ...own });
}

export interface ChatLeverState {
  /** Действующий авторежим разговора: выбор в чате, а без него глобальный. */
  autoMode: (chatId: string, sessionId: string | undefined) => boolean;
  /** Идёт ли (или шёл последним) прогон разговора с полным доступом. */
  bypass: (chatId: string, sessionId: string | undefined) => boolean;
}

/**
 * Ослабляет ли отправка чат. `fullAccess` — ход без единой проверки прав,
 * `autoApprove: true` — авторежим разговора. Повтор уже действующего положения
 * ничего не разрешает: окно шлёт запомненный выбор чата с каждым сообщением, а
 * ответ из Telegram продолжает ход с полным доступом тем же флагом.
 */
export function sendLoosens(body: unknown, chat: ChatLeverState): boolean {
  if (!body || typeof body !== 'object') return false;
  const raw = body as Record<string, unknown>;
  const chatId = typeof raw.chatId === 'string' ? raw.chatId : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  if (raw.fullAccess === true && !chat.bypass(chatId, sessionId)) return true;
  return raw.autoApprove === true && !chat.autoMode(chatId, sessionId);
}

/**
 * `PUT /api/project-git/split-settings`: не задано — строки проекта не меняются;
 * `null` — сброс к общим; иначе строки тела поверх общих.
 */
export function splitSettingsLoosen(
  effective: Readonly<Record<GroupRequestId, GroupPermissionLevel>>,
  defaults: Readonly<Record<GroupRequestId, GroupPermissionLevel>>,
  body: unknown,
): boolean {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (raw.permissions === undefined) return false;
  const own =
    raw.permissions && typeof raw.permissions === 'object'
      ? pickGroupPermissions(raw.permissions as Record<string, unknown>)
      : {};
  return groupLevelsLoosen(effective, { ...defaults, ...own });
}
