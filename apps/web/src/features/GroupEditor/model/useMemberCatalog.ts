import { ruleApi } from '@entities/Rule';
import { skillApi } from '@entities/Skill';
import { hookApi } from '@entities/Hook';
import { mcpServerApi } from '@entities/McpServer';
import { permissionApi } from '@entities/Permission';
import { useGroups } from '@entities/Group';
import { memberCatalog } from './memberCatalog';

/** Списки сущностей и собранный из них выбор участников группы. */
export function useMemberCatalog(excludeGroupId?: string) {
  const rules = ruleApi.useList().data ?? [];
  const skills = skillApi.useList().data ?? [];
  const hooks = hookApi.useList().data ?? [];
  const servers = mcpServerApi.useList().data ?? [];
  const permissions = permissionApi.useList().data ?? [];
  const { data: groups = [] } = useGroups();
  const items = memberCatalog(
    { rules, skills, hooks, servers, permissions, groups },
    excludeGroupId,
  );
  return { items, rules, skills, hooks, servers, permissions, groups };
}
