/**
 * Универсальный раздел MCP-серверов — для провайдеров Gemini и Cursor (JSON,
 * ключ `mcpServers`), Codex (TOML) и OpenCode (JSON, ключ `mcp`, иная форма
 * записи). Claude сюда НЕ попадает: его MCP живёт в ~/.claude.json и
 * обслуживается собственными богатыми роутами (OAuth, tools, health, группы) —
 * тот раздел не трогаем. Роутинг «claude → /api/mcp, прочие → /api/provider-mcp»
 * делает клиент по активному провайдеру.
 *
 * БЕЗОПАСНОСТЬ ПРЕЖДЕ ВСЕГО. Чужой конфиг не разрушаем:
 *  - Gemini/Cursor (`json`): JSON.parse → меняем ТОЛЬКО ключ `mcpServers` (и
 *    только одну запись в нём) → JSON.stringify(2) → бэкап + атомарная запись.
 *    Прочие ключи файла и прочие серверы сохраняются как есть. Нет файла →
 *    создаём с одним `mcpServers`. Адрес http пишется в `httpUrl` (gemini) или
 *    `url` (cursor) — по `jsonHttpUrlKey` провайдера; чтение понимает оба.
 *  - OpenCode (`opencode-json`): то же самое, но ключ `mcp` и другая форма
 *    записи сервера: `{type:'local', command:[cmd,...args], environment}` или
 *    `{type:'remote', url, headers}`. Поле `enabled` и любые НЕизвестные поля
 *    сервера сохраняются при round-trip; прочие ключи файла ($schema, model,
 *    agents, …) не трогаются.
 *  - Codex (`toml`): чтение через smol-toml. ЗАПИСЬ ХИРУРГИЧЕСКАЯ — не через
 *    полный stringify всего файла: находим регион таблиц [mcp_servers...] в
 *    тексте, вырезаем его и вставляем заново сгенерированный блок mcp_servers;
 *    model, approval_policy, комментарии и прочие секции остаются байт-в-байт.
 *
 * FAIL-CLOSED: если файл не парсится, регион mcp_servers неоднозначен (не
 * непрерывен), или итог не репарсится/не совпадает с намерением — НЕ пишем,
 * бросаем `UnrecognizedFormatError` (раздел только для чтения). Никогда не пишем
 * наугад.
 *
 * Код раздела лежит в `provider-mcp/`: цель и имена копий (`target.ts`), общие
 * проверки значений и слияние немоделируемых полей (`values.ts`), валидация
 * черновика (`draft.ts`), по модулю на формат (`*-format.ts`), диспетчер и
 * файлы-блоки Continue (`section.ts`, `blocks.ts`). Здесь — фасад: потребители
 * (роуты, тесты, соседние домены) импортируют раздел отсюда.
 */

// Переэкспорт для существующих потребителей (роуты/тесты импортируют его отсюда).
// Класс один и тот же (из lib) — `instanceof` работает в MCP- и env-разделах.
export { UnrecognizedFormatError } from '../lib/codex-toml.ts';

export type {
  ProviderMcpFormat,
  ProviderMcpSection,
  ProviderMcpTarget,
} from './provider-mcp/types.ts';
export { resolveProviderMcpTarget } from './provider-mcp/target.ts';
export {
  McpServerExistsError,
  McpServerNotFoundError,
  parseUniversalDraft,
} from './provider-mcp/draft.ts';
export {
  deleteProviderMcpServer,
  readProviderMcpSection,
  readProviderMcpServers,
  upsertProviderMcpServer,
} from './provider-mcp/section.ts';
