import { useQuery } from '@tanstack/react-query';
import { caseHistoryQuery } from '../lib/caseHistoryQuery';

export function useTestCaseHistory(
  path: string | undefined,
  groupId: string | undefined,
  caseId: string | undefined,
  stamp = '',
) {
  return useQuery(caseHistoryQuery(path, groupId, caseId, stamp));
}
