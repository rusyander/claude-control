import { ruleApi } from '@entities/Rule';
import { skillApi } from '@entities/Skill';
import { hookApi } from '@entities/Hook';
import { mcpServerApi } from '@entities/McpServer';
import { permissionApi } from '@entities/Permission';
import { useGroups } from '@entities/Group';
import { memberCatalog } from './memberCatalog';

/** Списки сущностей и собранный из них выбор участников группы. */
export function useMemberCatalog(excludeGroupId?: string) {
  const queries = [
    ruleApi.useList(),
    skillApi.useList(),
    hookApi.useList(),
    mcpServerApi.useList(),
    permissionApi.useList(),
    useGroups(),
  ] as const;
  const [ruleQ, skillQ, hookQ, serverQ, permissionQ, groupQ] = queries;
  const rules = ruleQ.data ?? [];
  const skills = skillQ.data ?? [];
  const hooks = hookQ.data ?? [];
  const servers = serverQ.data ?? [];
  const permissions = permissionQ.data ?? [];
  const groups = groupQ.data ?? [];
  // Пока хоть один список не пришёл, выбор участников неполон: помощник по
  // нему отвечал бы «участников нет», а не выбирал из настоящих.
  const loading = queries.some((query) => query.isPending);
  const items = memberCatalog(
    { rules, skills, hooks, servers, permissions, groups },
    excludeGroupId,
  );
  return { items, rules, skills, hooks, servers, permissions, groups, loading };
}
