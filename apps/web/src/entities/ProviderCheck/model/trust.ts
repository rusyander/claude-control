import type {
  ProviderCheckLevel,
  ProviderCheckResult,
  ProviderCheckStatus,
  ProviderChecksResponse,
  ProviderStatus,
} from '@claude-control/contracts';

/**
 * Из чего складывается бейдж доверия.
 *
 * До проверки панель может сказать только то, что знает из каталога: Claude
 * `verified`, остальные `experimental`. После проверки на этой машине появляется
 * факт посильнее обещания — «здесь круг чтения-записи сошёлся и ассистент
 * ответил». Он и вытесняет обещание: проверка провайдера ВСЕГДА важнее его
 * объявленного статуса, в обе стороны (провалившаяся проверка перебивает даже
 * `verified` у Claude — если у человека сломано, бейдж обязан это показывать).
 */
export type TrustTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface TrustBadge {
  /** Ключ словаря (`providerCheck.badge.*`). */
  key: string;
  tone: TrustTone;
  /** Дата последней проверки — показывается подсказкой, если она была. */
  checkedAt?: string;
}

/** Итог проверки конкретного провайдера (или `undefined`, если её не было). */
export function findCheck(
  checks: ProviderChecksResponse | undefined,
  providerId: string,
): ProviderCheckResult | undefined {
  return checks?.checks[providerId];
}

const LEVEL_BADGE: Record<ProviderCheckLevel, { key: string; tone: TrustTone }> = {
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

/** Тон значка шага — тот же язык цветов, что и у бейджа целиком. */
export function stepTone(status: ProviderCheckStatus): TrustTone {
  if (status === 'pass') return 'success';
  if (status === 'warn') return 'warning';
  if (status === 'fail') return 'danger';
  return 'neutral';
}

/** Сколько шагов прошло из тех, что вообще выполнялись (пропущенные не в счёт). */
export function checkScore(check: ProviderCheckResult): { passed: number; total: number } {
  const executed = check.steps.filter((step) => step.status !== 'skipped');
  return {
    passed: executed.filter((step) => step.status === 'pass').length,
    total: executed.length,
  };
}
