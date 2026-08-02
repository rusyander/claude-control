/**
 * Словарь значений, который обязаны знать оба конца: сервер и фронт.
 *
 * Сюда переехали наборы, которые до этого лежали двумя копиями — одна в
 * контрактах, вторая на сервере. Копии расходятся молча: у каждой стороны свой
 * тест, оба зелёные, а панель отдаёт значение, которого другая сторона не знает.
 * Ни `type-check`, ни `lint` этого не видят.
 *
 * ВАЖНО про импорт на сервере. Сервер идёт под `node --experimental-strip-types`
 * и ЗНАЧЕНИЯ из бочки `@claude-control/contracts` брать не может: её реэкспорты
 * без расширений Node не резолвит. Поэтому файл самодостаточен (ни одного
 * импорта) и вынесен отдельной точкой экспорта — `@claude-control/contracts/vocabulary`,
 * как и `contracts/uploads`. Не добавлять сюда импорты: сервер перестанет
 * стартовать.
 *
 * Имена здесь — константы (`SCREAMING_CASE`). Обе стороны реэкспортируют их под
 * своими прежними именами, поэтому ни один существующий импорт не меняется.
 */

/**
 * Возможности провайдера — по разделам панели. Активный провайдер отдаёт статус
 * по каждому ключу, клиент по нему решает, что показывать.
 */
export const CAPABILITIES = [
  'rules',
  'globalInstructions',
  'skills',
  'commands',
  'hooks',
  'scripts',
  'mcp',
  'permissions',
  'env',
  'plugins',
  'analytics',
  'projects',
  'chat',
  'sandbox',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Статус конкретной возможности у провайдера:
 * - `ready` — реально работает сейчас (есть адаптер, чтение/запись безопасны);
 * - `planned` — по карте поддержим, адаптера ещё нет → раздел показывается с
 *   пометкой «в разработке», но ничего не читает и не пишет (fail-closed);
 * - `unsupported` — у этого CLI такого раздела нет → скрыт из навигации.
 */
export type CapabilityStatus = 'ready' | 'planned' | 'unsupported';

/**
 * Статус провайдера целиком:
 * - `verified` — поведение проверено (Claude);
 * - `experimental` — форматы взяты из документации, часть разделов в разработке.
 */
export type ProviderStatus = 'verified' | 'experimental';

/**
 * Уровни прав OpenCode (ключ `permission` в `opencode.json`): `allow` —
 * выполнять без вопроса, `ask` — спрашивать каждый раз, `deny` — запретить.
 * Всё, что вне набора, сервер отклоняет до записи.
 */
export const OPENCODE_PERMISSION_LEVELS = ['allow', 'deny', 'ask'] as const;
export type OpencodePermissionLevel = (typeof OPENCODE_PERMISSION_LEVELS)[number];

/**
 * Инструменты OpenCode, у которых уровень прав ЗАДОКУМЕНТИРОВАН: правка файлов,
 * запуск команд оболочки и загрузка страниц. Прочие ключи внутри `permission`
 * панель не ведёт — они сохраняются как есть и показываются только для чтения.
 */
export const OPENCODE_PERMISSION_TOOLS = ['edit', 'bash', 'webfetch'] as const;
export type OpencodePermissionTool = (typeof OPENCODE_PERMISSION_TOOLS)[number];

/** Режимы аппрувов Goose: значение корневого ключа `GOOSE_MODE`. */
export const GOOSE_MODES = ['auto', 'approve', 'smart_approve', 'chat'] as const;
export type GooseMode = (typeof GOOSE_MODES)[number];

/** Режимы аппрувов Kimi Code: значение корневого ключа `default_permission_mode`. */
export const KIMI_MODES = ['manual', 'auto', 'yolo'] as const;
export type KimiMode = (typeof KIMI_MODES)[number];

/** Решение правила Kimi: что делать с подходящим вызовом инструмента. */
export const KIMI_DECISIONS = ['allow', 'ask', 'deny'] as const;
export type KimiDecision = (typeof KIMI_DECISIONS)[number];
