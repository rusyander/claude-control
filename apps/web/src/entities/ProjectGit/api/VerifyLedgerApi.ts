import { useQuery } from '@tanstack/react-query';
import type { LedgerSummary } from '@agentdeck/contracts/verify-ledger';
import { apiClient } from '@shared/api/client';
import { verifyLedgerKey } from './VerifyLedgerApi.constants';

/** Сводка журнала проверок: замер тени, повторы, расхождения, пульс CLI. */
export function useVerifyLedger() {
  return useQuery({
    queryKey: verifyLedgerKey,
    queryFn: async () => {
      const { data } = await apiClient.get<LedgerSummary>('/verify-ledger');
      return data;
    },
  });
}
