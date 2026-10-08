import type { GroupPathProps } from '../ui/GroupPath/GroupPath.types';
import { scopeOf } from '@agentdeck/contracts';

export function projectPathOf(group: GroupPathProps['group']): string | undefined {
  const scope = scopeOf(group);
  return scope.kind === 'project' ? scope.path : undefined;
}
