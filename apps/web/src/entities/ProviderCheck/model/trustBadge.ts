import type { TrustTone } from './trust.types';
import type { ProviderCheckLevel, ProviderStatus, ProviderCheckResult } from '@agentdeck/contracts';

export interface TrustBadge {
  /** Ключ словаря (`providerCheck.badge.*`). */
  key: string;
  tone: TrustTone;
  /** Дата последней проверки — показывается подсказкой, если она была. */
  checkedAt?: string;
}

export const LEVEL_BADGE: Record<ProviderCheckLevel, { key: string; tone: TrustTone }> = {
  verified: { key: 'providerCheck.badge.verified', tone: 'success' },
  partial: { key: 'providerCheck.badge.partial', tone: 'warning' },
  failed: { key: 'providerCheck.badge.failed', tone: 'danger' },
};

/** Бейдж доверия провайдера: проверка на этой машине, иначе статус из каталога. */
export function trustBadge(
  status: ProviderStatus,
  check: ProviderCheckResult | undefined,
): TrustBadge {
  if (check) return { ...LEVEL_BADGE[check.level], checkedAt: check.at };
  return status === 'verified'
    ? { key: 'settings.providerVerified', tone: 'success' }
    : { key: 'settings.providerExperimental', tone: 'warning' };
}
