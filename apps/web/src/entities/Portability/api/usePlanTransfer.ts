import type { TransferPair } from './PortabilityApi.types';
import type { TransferPlan } from '@agentdeck/contracts/portable-transfer';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

export async function postPlan(pair: TransferPair): Promise<TransferPlan> {
  const { data } = await apiClient.post<TransferPlan>('/portability/plan', pair);
  return data;
}

/**
 * План переноса. Мутация, хотя сервер ничего не пишет: это не ресурс, который
 * можно тянуть фоном при каждом открытии страницы, — план выполняет настоящие
 * операции адаптеров по временным копиям и считается только по нажатию.
 */
export function usePlanTransfer() {
  return useMutation({ meta: { silentError: true }, mutationFn: postPlan });
}
