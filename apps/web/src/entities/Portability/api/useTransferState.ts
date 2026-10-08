import type { TransferPair, PortabilityLevel } from './PortabilityApi.types';
import type { TransferStateAnswer } from '@agentdeck/contracts/portable-transfer';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getTransferState(pair: TransferPair): Promise<TransferStateAnswer> {
  const { data } = await apiClient.get<TransferStateAnswer>('/portability/transfer', {
    params: pair,
  });
  return data;
}

/**
 * След применённого переноса — то, с чем страница ОТКРЫВАЕТСЯ.
 *
 * Обычный запрос, а не память вкладки: человек, вернувшийся к экрану на
 * следующий день, обязан увидеть кнопку отмены. Держи мы след только в
 * состоянии компонента, F5 оставлял бы его с перенесённой средой и без единого
 * способа её вернуть — ровно та неизвестная цена ошибки, из-за которой первую
 * кнопку не нажимают.
 */
export function useTransferState(provider: string, target: string, level: PortabilityLevel) {
  return useQuery({
    queryKey: queryKeys.portabilityTransfer(provider, target, level.scope, level.project),
    queryFn: () => getTransferState({ provider, target, ...level }),
    enabled: Boolean(provider && target) && (level.scope === 'global' || Boolean(level.project)),
  });
}
