import type { UsageLimitsStatus } from '@agentdeck/contracts';
import type { CredentialsLookup } from '../../lib/credentials/credentials.ts';

/** Токен для запроса — или причина, по которой запроса не будет. */
export type OAuthTokenResult = { token: string } | { status: UsageLimitsStatus };

/** Запас до конца срока: токен, истекающий на лету, сервер отвергнет. */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * Токен CLI из найденного доступа (`readClaudeCredentials`: файл, связка ключей
 * macOS или файл панели). Сам токен дальше этой функции и запроса не идёт: ни в
 * ответ, ни в журнал, ни в текст ошибки.
 *
 * Просроченный токен панель НЕ обновляет: обновление выдаёт новую пару токенов,
 * и прежний refresh-токен CLI перестаёт действовать — вход CLI выбило бы. CLI
 * обновит его сам при следующем запуске.
 */
export function oauthTokenOf(lookup: CredentialsLookup, now: number): OAuthTokenResult {
  if (lookup.apiKey) return { status: 'api-key' };
  if (!lookup.content) return { status: 'no-credentials' };
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    const parsed = JSON.parse(lookup.content) as { claudeAiOauth?: typeof oauth };
    oauth = parsed.claudeAiOauth;
  } catch {
    return { status: 'no-credentials' };
  }
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || !token) return { status: 'no-credentials' };
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { status: 'token-expired' };
  }
  return { token };
}
