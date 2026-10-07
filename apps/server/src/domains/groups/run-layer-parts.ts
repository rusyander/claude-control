import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Group, GroupMember } from '@agentdeck/contracts';
import type { GroupLayerDelivered, GroupLayerRefusal } from '@agentdeck/contracts/group-delivery';
import { inClaudeGlobals, type GroupScope } from '@agentdeck/contracts/group-sources';
import { readJsonFile } from '../../lib/safe-io.ts';
import { serverText } from '../../lib/server-texts.ts';
import { readHooks, readHooksFromFiles } from '../hooks.ts';
import { DISABLED_MCP_KEY } from '../mcp.ts';
import { memberScope, projectClaudeDir, type MemberDeps } from './members.ts';

/**
 * Общие части слоёв группы на прогон. Отдельно от реестра (`run-layer.ts`):
 * реестр импортирует писателей, а писатели — эти части, и при одном модуле
 * на двоих круговой импорт обращался бы к писателю до его объявления.
 */

/**
 * Прогон отказан целиком, ничего не обрезано (Codex: правила длиннее предела).
 * Тот же исход, что у упавшего прогона: процесс не поднимается, причина — в ленте.
 */
export class GroupLayerBlocked extends Error {
  readonly code: 'group-layer-too-large';
  readonly params: Record<string, string>;
  constructor(code: 'group-layer-too-large', params: Record<string, string>) {
    super(serverText(code, params));
    this.code = code;
    this.params = params;
  }
}

/** Лист группы: участник, где лежат его файлы и чья это группа прогона. */
export interface GroupLeaf {
  group: Group;
  member: GroupMember;
  scope: GroupScope;
}

/**
 * Листья групп по порядку: вложенные общие группы Claude раскрываются, циклы
 * обрываются. Лист помнит ВЕРХНЮЮ группу прогона: её имя человек выбирал и её
 * видит в заметке.
 */
export function groupLeaves(all: readonly Group[], groups: readonly Group[]): GroupLeaf[] {
  const byId = new Map(all.filter((item) => inClaudeGlobals(item.scope)).map((g) => [g.id, g]));
  const leaves: GroupLeaf[] = [];
  for (const top of groups) {
    const seen = new Set<string>();
    const walk = (owner: Group, path: Set<string>): void => {
      for (const member of owner.members) {
        if (member.kind === 'group') {
          const sub = byId.get(member.id);
          if (!sub || path.has(sub.id)) continue;
          walk(sub, new Set([...path, sub.id]));
          continue;
        }
        const scope = memberScope(owner, member);
        const key = `${member.kind}:${member.id}:${JSON.stringify(scope)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        leaves.push({ group: top, member, scope });
      }
    };
    walk(top, new Set([top.id]));
  }
  return leaves;
}

/**
 * Переменные групп одним набором: первая группа выигрывает, повтор имени в
 * следующей — отказ `group-layer-duplicate`, а не тихая перезапись.
 */
export function mergeGroupEnv(groups: readonly Group[]): {
  env: Record<string, string>;
  delivered: GroupLayerDelivered[];
  refused: GroupLayerRefusal[];
} {
  const env: Record<string, string> = {};
  const owner = new Map<string, string>();
  const delivered: GroupLayerDelivered[] = [];
  const refused: GroupLayerRefusal[] = [];
  for (const group of groups) {
    for (const [name, value] of Object.entries(group.env ?? {})) {
      if (typeof value !== 'string') continue;
      const member = `env:${name}`;
      const first = owner.get(name);
      if (first !== undefined) {
        refused.push({
          group: group.id,
          member,
          code: 'group-layer-duplicate',
          params: { id: name, group: first },
        });
        continue;
      }
      owner.set(name, group.name);
      env[name] = value;
      delivered.push({ group: group.id, member });
    }
  }
  return { env, delivered, refused };
}

/** Запись сервера: включённая или выключенная — группа несёт её в любом состоянии Claude. */
export function groupMcpRaw(deps: MemberDeps, scope: GroupScope, id: string): unknown {
  const file = scope.kind === 'project' ? join(scope.path, '.mcp.json') : deps.paths.mcpConfig;
  const config = readJsonFile<Record<string, Record<string, unknown> | undefined>>(file, {});
  for (const key of ['mcpServers', DISABLED_MCP_KEY]) {
    const servers = config[key];
    if (servers && Object.hasOwn(servers, id)) return servers[id];
  }
  return undefined;
}

/**
 * Таймаут хука Claude в секундах. Читается из самих настроек: текст участника
 * (`members.ts`) таймаута не несёт, а слой обязан сохранить заданный человеком.
 */
export function groupHookTimeoutSeconds(
  deps: MemberDeps,
  scope: GroupScope,
  id: string,
): number | undefined {
  const root = scope.kind === 'project' ? scope.path : undefined;
  const dir = root ? projectClaudeDir(root) : undefined;
  const hooks = dir
    ? readHooksFromFiles(join(dir, 'settings.json'), join(dir, 'settings.local.json'), root)
    : readHooks(deps.paths.settings, deps.store);
  const seconds = hooks.find((hook) => hook.id === id)?.timeout;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
}

/** Правила групп одним текстом, каждая группа под своим именем; правил нет — пусто. */
export function groupRulesText(rules: readonly { group: string; text: string }[]): string {
  if (rules.length === 0) return '';
  const byGroup = new Map<string, string[]>();
  for (const rule of rules)
    byGroup.set(rule.group, [...(byGroup.get(rule.group) ?? []), rule.text]);
  const parts = [...byGroup].map(
    ([group, texts]) =>
      `# Group "${group}" (added by the panel for this run)\n\n## Rules\n\n${texts.join('\n\n')}`,
  );
  return parts.join('\n\n') + '\n';
}

/** Отпечаток для каталога и заметки: 16 знаков sha256. */
export function layerDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
