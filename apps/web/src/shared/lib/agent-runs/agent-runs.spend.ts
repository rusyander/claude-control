import { apiClient } from '@shared/api/client';
import { emit } from './agent-runs.state';

/**
 * Накопленный за сеанс расход. Считает его сервер (реестр прогонов) — так
 * счётчик переживает перезагрузку вкладки, как и сами прогоны; клиент лишь
 * подтягивает значение. Прежде он жил в памяти вкладки и обнулялся на F5.
 */
let sessionSpend = { costUsd: 0, tokens: 0 };

/** Подтянуть накопленный за сеанс расход с сервера (переживает F5). */
export async function loadSpend(): Promise<void> {
  try {
    const { data } = await apiClient.get('/chat/spend');
    sessionSpend = {
      costUsd: Number((data as { costUsd?: number })?.costUsd) || 0,
      tokens: Number((data as { tokens?: number })?.tokens) || 0,
    };
    emit();
  } catch {
    // Нет связи — оставляем прежнее значение.
  }
}

export function getTotalCost(): number {
  return sessionSpend.costUsd;
}

export function getTotalTokens(): number {
  return sessionSpend.tokens;
}
