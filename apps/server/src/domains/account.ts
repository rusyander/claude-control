import { readJsonFile } from '../lib/safe-io.ts';

/**
 * Кто владелец подписки. Данные лежат в ~/.claude.json — их кладёт туда сам
 * Claude Code после входа. Остатков лимитов там нет: они живут на серверах
 * Anthropic и запрашиваются командой /usage в интерактивной сессии.
 */
export interface AccountInfo {
  email?: string;
  displayName?: string;
  organization?: string;
  /** Тип оплаты: подписка или оплата по мере использования. */
  billingType?: string;
  isSubscription: boolean;
  hasExtraUsage?: boolean;
}

interface RawConfig {
  oauthAccount?: {
    emailAddress?: string;
    displayName?: string;
    accountUuid?: string;
    organizationName?: string;
    organizationUuid?: string;
    billingType?: string;
    hasExtraUsageEnabled?: boolean;
  };
}

export function readAccount(mcpConfigPath: string): AccountInfo {
  const config = readJsonFile<RawConfig>(mcpConfigPath, {});
  const account = config.oauthAccount;

  if (!account) return { isSubscription: false };

  return {
    email: account.emailAddress,
    // Имени в конфиге может не быть — тогда показываем часть до @.
    displayName: account.displayName ?? account.emailAddress?.split('@')[0],
    organization: account.organizationName,
    billingType: account.billingType,
    isSubscription: (account.billingType ?? '').includes('subscription'),
    hasExtraUsage: account.hasExtraUsageEnabled,
  };
}
