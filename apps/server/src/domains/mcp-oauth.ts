/**
 * Интерактивный OAuth для сетевых MCP-серверов.
 *
 * Сам протокол ведёт официальный SDK: обнаружение сервера авторизации
 * (RFC 9728 / 8414), динамическую регистрацию клиента (RFC 7591), PKCE и
 * обновление токена он делает внутри `auth()` — транспорт вызывает его сам,
 * получив 401. Здесь остаётся то, что относится к приложению: где хранить
 * выданные токены, как дождаться редиректа после входа и как назвать статус
 * словами для страницы.
 *
 * Хранилище — отдельный файл `claude-control/mcp-oauth.json` с правами 600:
 * в нём лежат access/refresh-токены, то есть секреты. Регистрация клиента
 * (client_id, выданный сервером при DCR) хранится там же, чтобы обновление
 * токена после перезапуска не начинало регистрацию заново.
 *
 * Модули: `mcp-oauth/store.ts` — файл токенов и его очередь записи,
 * `mcp-oauth/callback.ts` — адрес возврата и страница исхода,
 * `mcp-oauth/provider.ts` — провайдер для SDK, `mcp-oauth/flow.ts` — старт и
 * завершение входа.
 */

export { oauthCallbackPage, oauthCallbackUrl } from './mcp-oauth/callback.ts';
export { finishOAuth, startOAuth, type StartOAuthResult } from './mcp-oauth/flow.ts';
export { oauthProviderFor } from './mcp-oauth/provider.ts';
export { clearOAuth, hasOAuthTokens, oauthStorePath, renameOAuth } from './mcp-oauth/store.ts';
