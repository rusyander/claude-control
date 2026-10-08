import type { GroupRecheckProps } from '../ui/GroupRecheck.types';
import type { RecheckView } from '../ui/GroupRecheck/GroupRecheck.types';

export function viewOf(recheck: GroupRecheckProps['recheck']): RecheckView {
  if (recheck.requestedAt) return 'pending';
  return recheck.checkedAt ? 'checked' : 'open';
}
