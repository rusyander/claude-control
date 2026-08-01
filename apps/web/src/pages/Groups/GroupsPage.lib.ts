import type { GroupMember } from '@claude-control/contracts';
import type { SandboxSelection } from '@entities/Sandbox';

/**
 * Состав группы для песочницы. Права в изолированный прогон не переносим:
 * там свои границы, и чужие разрешения их только запутали бы.
 */
export function selectionOfGroup(members: GroupMember[]): SandboxSelection {
  return {
    ruleIds: members.filter((item) => item.kind === 'rule').map((item) => item.id),
    skillIds: members.filter((item) => item.kind === 'skill').map((item) => item.id),
    hookIds: members.filter((item) => item.kind === 'hook').map((item) => item.id),
    mcpIds: members.filter((item) => item.kind === 'mcp').map((item) => item.id),
  };
}
