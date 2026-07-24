/**
 * Абстракция провайдера конфигурации (мульти-провайдерность).
 *
 * Панель по умолчанию работает с Claude Code, но пользователь может выбрать
 * другой CLI (Codex, Gemini, Cursor, OpenCode, Aider). Здесь — только
 * КЛИЕНТСКАЯ форма: статус провайдера и карта статусов его возможностей. По ней
 * клиент гейтит навигацию. Реальные адаптеры (пути, запуск CLI, чтение/запись
 * форматов) живут на стороне сервера в `apps/server/src/providers/` — контракты
 * тянутся в сервер лишь как тип.
 */

/**
 * Возможности провайдера — по разделам панели. Активный провайдер отдаёт карту
 * статусов по каждому ключу; клиент по ней решает, что показать. У Claude есть
 * всё; у более простого CLI часть разделов ещё не реализована или отсутствует.
 */
export const CAPABILITIES = [
  'rules',
  'globalInstructions',
  'skills',
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
 * Как у провайдера устроены глобальные инструкции:
 * - `file` — ОДИН файл целиком (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`);
 * - `list` — СПИСОК ССЫЛОК на файлы в конфиге (у Aider опция `read` в
 *   `.aider.conf.yml`: единого файла инструкций у него нет);
 * - `rules` — КАТАЛОГ ПРАВИЛ `.mdc` с YAML-frontmatter (у Cursor это
 *   `~/.cursor/rules/` и `<проект>/.cursor/rules/`, вложенные подкаталоги
 *   поддерживаются): много файлов, у каждого свои `description`/`globs`/
 *   `alwaysApply`;
 * - `none` — раздела инструкций у провайдера нет (или адаптер ещё не написан).
 *
 * Клиент по этому полю выбирает страницу раздела, а не по id провайдера.
 */
export type ProviderInstructionsModel = 'file' | 'list' | 'rules' | 'none';

/** Краткая карточка провайдера для клиента: id, имя, статус и карта возможностей. */
export interface ProviderInfo {
  id: string;
  name: string;
  status: ProviderStatus;
  capabilities: Record<Capability, CapabilityStatus>;
  /** Модель раздела инструкций: один файл, список ссылок или раздела нет. */
  instructionsModel: ProviderInstructionsModel;
}

/** Ответ `GET /api/providers`: id активного провайдера и список известных. */
export interface ProvidersResponse {
  active: string;
  providers: ProviderInfo[];
}
