import type { TransferPlan } from '@agentdeck/contracts/portable-transfer';

/**
 * Свежий план из отказа 409: сервер присылает его вместе с «файлы изменились».
 *
 * Разбор осторожный — это тело чужого ответа, а не наш тип: без проверки полей
 * раздел поставил бы на место плана что угодно, что там оказалось, и показал бы
 * человеку пустой экран вместо плана.
 */
export function freshPlanOf(error: unknown): TransferPlan | null {
  const data: unknown = (error as { response?: { data?: unknown } })?.response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const { plan } = data as { plan?: unknown };
  if (typeof plan !== 'object' || plan === null) return null;
  const candidate = plan as Partial<TransferPlan>;
  return typeof candidate.fingerprint === 'string' && Array.isArray(candidate.files)
    ? (plan as TransferPlan)
    : null;
}
