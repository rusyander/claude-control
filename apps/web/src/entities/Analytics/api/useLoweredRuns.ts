import { useQuery } from '@tanstack/react-query';
import { getLoweredRuns } from '../lib/getLoweredRuns';

export function useLoweredRuns() {
  return useQuery({ queryKey: ['chat', 'lowered-runs'], queryFn: getLoweredRuns });
}
