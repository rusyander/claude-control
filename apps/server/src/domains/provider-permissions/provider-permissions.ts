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
 * Разбор черновиков семи CLI (и отказ `yolo` у Gemini) — одной копией с ядром в
 * `@agentdeck/contracts/permissions`; роуты берут его оттуда напрямую.
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
export { UnrecognizedFormatError } from '../../lib/codex-toml/codex-toml.ts';

export { resolveProviderPermissionsTarget } from './target.ts';

export { geminiOtherKeysProjection } from './gemini.ts';

export {
  buildProviderPermissionInfo,
  parseProviderPermissionsDraft,
  readProviderPermissions,
  saveProviderPermissions,
} from './dispatch.ts';

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
} from './types.ts';
