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
 *
 * Сам набор живёт в `./vocabulary` — он нужен и серверу как ЗНАЧЕНИЕ, а бочку
 * контрактов сервер импортировать не может (см. комментарий там). Здесь только
 * реэкспорт, чтобы имя осталось на прежнем месте.
 */
import type { Capability, CapabilityStatus, ProviderStatus } from './vocabulary';

export {
  CAPABILITIES,
  type Capability,
  type CapabilityStatus,
  type ProviderStatus,
} from './vocabulary';

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

/**
 * Как у провайдера устроены ХУКИ (OPENCODE-3):
 * - `claude` — богатая модель Claude: события `PreToolUse`/`PostToolUse` с
 *   матчерами инструментов и shell-командами в `settings.json`, собственные
 *   маршруты `/api/hooks`. Раздел показывается прежней страницей без изменений;
 * - `config` — хуки лежат ключом в конфиге CLI (у OpenCode это
 *   `experimental.hook` в `opencode.json`): ровно два задокументированных
 *   события, действия — argv-массивы. Универсальная страница раздела;
 * - `none` — хуков у провайдера нет (или адаптер ещё не написан).
 *
 * Клиент по этому полю выбирает страницу раздела, а не по id провайдера.
 */
export type ProviderHooksModel = 'claude' | 'config' | 'none';

/**
 * Как у провайдера устроены ПЛАГИНЫ (OPENCODE-4):
 * - `panel` — раздел «Плагины» самой панели (расширения панели, не CLI): это
 *   ветка Claude, прежняя страница без изменений;
 * - `files` — плагины САМОГО CLI: каталог файлов JS/TS, подхватываемых при
 *   старте, плюс список npm-пакетов в конфиге (OpenCode);
 * - `none` — плагинов у провайдера нет (или адаптер ещё не написан).
 */
export type ProviderPluginsModel = 'panel' | 'files' | 'none';

/**
 * Как у провайдера устроены СКИЛЛЫ (OPENCODE-5):
 * - `claude` — раздел скиллов Claude: папки в `~/.claude/skills` с включением
 *   через перенос в `skills-disabled`, группы, ассистент формы. Прежняя страница
 *   без изменений;
 * - `files` — каталог скиллов самого CLI: `<каталог>/<имя>/SKILL.md` с шапкой
 *   `name`/`description` (OpenCode, глобально и в проекте);
 * - `none` — скиллов у провайдера нет (или адаптер ещё не написан).
 *
 * Клиент по этому полю выбирает страницу раздела, а не по id провайдера.
 */
export type ProviderSkillsModel = 'claude' | 'files' | 'none';

/** Краткая карточка провайдера для клиента: id, имя, статус и карта возможностей. */
export interface ProviderInfo {
  id: string;
  name: string;
  status: ProviderStatus;
  capabilities: Record<Capability, CapabilityStatus>;
  /** Модель раздела инструкций: один файл, список ссылок или раздела нет. */
  instructionsModel: ProviderInstructionsModel;
  /** Модель раздела хуков: богатая claude-овская или ключ в конфиге CLI. */
  hooksModel: ProviderHooksModel;
  /** Модель раздела плагинов: расширения панели или плагины самого CLI. */
  pluginsModel: ProviderPluginsModel;
  /** Модель раздела скиллов: богатая claude-овская или каталог `SKILL.md` у CLI. */
  skillsModel: ProviderSkillsModel;
}

/** Ответ `GET /api/providers`: id активного провайдера и список известных. */
export interface ProvidersResponse {
  active: string;
  providers: ProviderInfo[];
}
