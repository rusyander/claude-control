/**
 * Универсальный раздел прав/аппрувов — для провайдеров Codex (TOML), Gemini
 * (settings.json) и OpenCode (opencode.json). Claude сюда НЕ попадает: его права
 * живут в settings.json (permissions allow/deny/ask) и обслуживаются собственными
 * богатыми роутами — тот раздел не трогаем.
 * Роутинг «claude → свои роуты, прочие → /api/provider-permissions» делает клиент
 * по активному провайдеру.
 *
 * БЕЗОПАСНОСТЬ ПРЕЖДЕ ВСЕГО.
 *
 * Модель прав каждого провайдера — в своём модуле `provider-permissions/`:
 * `codex.ts`, `gemini.ts`, `qwen.ts`, `continue.ts`, `cursor.ts`, `goose.ts`,
 * `kimi.ts`, `opencode.ts`; там же описан ведомый панелью кусок его файла.
 * Разбор черновика, чтение, запись и сводка ПО ФОРМАТУ ЦЕЛИ — `dispatch.ts`,
 * цель активного провайдера — `target.ts`, общая нормализация — `normalize.ts`.
 * Этот файл — фасад: набор экспортов для роутов и тестов.
 *
 * ВАЛИДАЦИЯ ENUM ДО ЗАПИСИ: значение вне разрешённого набора отклоняется на разборе
 * черновика (маршрут отвечает 400) — в файл не пишется.
 *
 * FAIL-CLOSED: файл не парсится / итог не репарсится / итог ≠ намерению → НЕ
 * пишем, бросаем `UnrecognizedFormatError` (раздел только для чтения; маршрут
 * 422). Никогда не пишем наугад.
 */

// Переэкспорт для роутов/тестов; класс один и тот же (из lib) — `instanceof` цел.
export { UnrecognizedFormatError } from '../lib/codex-toml.ts';

export {
  GEMINI_APPROVAL_MODES,
  GEMINI_CLI_ONLY_APPROVAL_MODES,
  QWEN_APPROVAL_MODES,
} from './provider-permissions/constants.ts';

export { resolveProviderPermissionsTarget } from './provider-permissions/target.ts';

export {
  geminiOtherKeysProjection,
  isCliOnlyGeminiApprovalMode,
} from './provider-permissions/gemini.ts';

export {
  buildProviderPermissionInfo,
  parseProviderPermissionsDraft,
  readProviderPermissions,
  saveProviderPermissions,
} from './provider-permissions/dispatch.ts';

export type {
  CodexPermissionsValues,
  ContinuePermissionsValues,
  CursorPermissionsValues,
  GeminiPermissionsValues,
  GoosePermissionsValues,
  KimiPermissionsValues,
  OpencodePermissionsValues,
  ProviderPermissionsFormat,
  ProviderPermissionsTarget,
  ProviderPermissionsValues,
  QwenPermissionsValues,
} from './provider-permissions/types.ts';
