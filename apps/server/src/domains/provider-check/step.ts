import type { ProviderCheckStep } from '@claude-control/contracts';
import { getProvider } from '../../providers/registry.ts';

/** Один шаг проверки: путь к файлу добавляем, только если он есть. */
export function step(
  id: ProviderCheckStep['id'],
  status: ProviderCheckStep['status'],
  detail: string,
  filePath?: string,
): ProviderCheckStep {
  return filePath ? { id, status, detail, filePath } : { id, status, detail };
}

/** Текст ошибки адаптера в одну строку — в интерфейс уходит именно он. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Почему круг записи не выполнялся. Два разных случая, и путать их нельзя:
 * у Claude раздел ЕСТЬ, просто живёт на своих богатых маршрутах и универсальным
 * адаптером не обслуживается; у прочих раздела нет вовсе (fail-closed).
 */
export function skipReason(
  providerId: string,
  capability: 'mcp' | 'permissions' | 'env',
  title: string,
): string {
  const provider = getProvider(providerId);
  return provider.capabilities[capability] === 'ready'
    ? `${title}: раздел обслуживается собственными маршрутами панели, универсальный круг записи к нему не применяется.`
    : `${title}: у этого провайдера такого раздела нет.`;
}
