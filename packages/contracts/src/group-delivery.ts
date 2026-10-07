/**
 * Как группа доходит до прогона чужого CLI — общий словарь сервера и клиентов.
 *
 * Группа живёт в файлах Claude, а чужой CLI их не читает. Тумблер каталогов
 * Claude ему поэтому ничего не даёт: группа едет СЛОЕМ на один прогон (Qwen —
 * файл системных настроек, Codex — накладка поверх его конфига), а у CLI без
 * слоя не действует вовсе — и это говорится, а не прячется за тихим
 * включением в `~/.claude`.
 *
 * Модуль без zod: его читают сервер без сборки и телефон.
 */

/** Чем слой подаётся: у каждого CLI свой механизм «на один запуск». */
export type GroupLayerKind = 'qwen-system-settings' | 'codex-overlay';

/**
 * Что значит группа для провайдера:
 * - `claude-files` — тумблер правит каталоги Claude (сам Claude);
 * - `run-layer` — группа едет слоем на каждый прогон, файлы не меняются;
 * - `none` — слоя у панели нет, группа на прогоны этого CLI не действует.
 */
export type GroupsModel = 'claude-files' | 'run-layer' | 'none';

/** Почему участник группы не доехал до прогона — код текста сервера. */
export const groupLayerRefusalCodes = [
  'group-layer-permission',
  'group-layer-mcp-sse',
  'group-layer-mcp-name',
  'group-layer-mcp-secret-header',
  'group-layer-mcp-shape',
  'group-layer-skill-name',
  'group-layer-hook-event',
  'group-layer-hook-event-native',
  'group-layer-missing',
  'group-layer-duplicate',
] as const;
export type GroupLayerRefusalCode = (typeof groupLayerRefusalCodes)[number];

/** Участник, который на прогон не едет, и почему. */
export interface GroupLayerRefusal {
  /** Группа, которой участник принадлежит (id). */
  group: string;
  /** `kind:id` участника; переменная окружения группы — `env:ИМЯ`. */
  member: string;
  code: GroupLayerRefusalCode;
  /** Подстановки текста (`{{cli}}`, `{{id}}`, `{{event}}`, `{{group}}`). */
  params: Record<string, string>;
}

/** Участник, который едет на прогон. */
export interface GroupLayerDelivered {
  group: string;
  member: string;
}

/**
 * Ответ `GET /api/groups/:id/delivery?provider=` — что группа дала бы прогону
 * этого CLI, без единой записи на диск.
 */
export interface GroupDelivery {
  groupId: string;
  provider: string;
  /** Имя CLI для подписи. */
  cliName: string;
  model: GroupsModel;
  /** Включена ли группа для этого CLI (у Claude — `isEnabled`). */
  enabled: boolean;
  delivered: GroupLayerDelivered[];
  refused: GroupLayerRefusal[];
  /** Переменные окружения группы, которые дойдут до прогона (только имена). */
  envNames: string[];
  /** Отпечаток содержимого слоя; у `none` и `claude-files` — нет. */
  digest?: string;
}
