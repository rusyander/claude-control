import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Group, GroupMember } from '@agentdeck/contracts';
import type { CopyWarning } from '@agentdeck/contracts/group-sources';
import { scopeOf } from '@agentdeck/contracts/group-sources';
import type { AgentEnvironment, EnvItem } from '@agentdeck/contracts/portable-env';
import { landsAtTarget } from '@agentdeck/contracts/portable-emit';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import type { EntityToggleDeps } from '../../entity-toggle.ts';
import { applyTransfer } from '../../portability/apply.ts';
import { importEnvironment } from '../../portability/import/index.ts';
import { buildTransferPlan } from '../../portability/plan.ts';
import { assertNotCopied } from '../choice/choice.ts';
import { GroupRequestError } from '../errors.ts';
import { carriedKnobs } from '../knobs/knobs.ts';
import { memberContent, memberHashes, memberKey, memberScope } from '../members/members.ts';

/**
 * Копия проектной группы в общие каталоги ЧУЖОГО провайдера — путём переноса
 * окружения: проект читается импортёром Claude, план строится только по
 * записям участников, применение — `applyTransfer` с копиями и откатом.
 * Свой писатель здесь был бы вторым переносом, который расходится с первым.
 */

function normalized(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').toLowerCase();
}

/** Запись среды, соответствующая участнику; нет — участник не переносится. */
export function envItemFor(
  env: AgentEnvironment,
  member: { kind: string; id: string },
  file: string | undefined,
  hookCommand: string | undefined,
): EnvItem | undefined {
  return env.items.find((item) => {
    if (member.kind === 'skill' && item.kind === 'skill') {
      return item.dir !== null && basename(item.dir) === member.id;
    }
    if (member.kind === 'mcp' && item.kind === 'mcpServer') return item.name === member.id;
    if (member.kind === 'hook' && item.kind === 'hook') return item.command === hookCommand;
    if (member.kind === 'rule' && item.kind === 'instructions') {
      return file !== undefined && normalized(item.source.file) === normalized(file);
    }
    return false;
  });
}

export function copyGroupToProvider(
  deps: EntityToggleDeps,
  source: Group,
  target: ConfigProvider,
  claude: ConfigProvider,
  options: { override?: string; now?: string; makeId?: () => string } = {},
): { group: Group; warnings: CopyWarning[] } {
  const scope = scopeOf(source);
  if (scope.kind !== 'project') {
    throw new GroupRequestError(409, 'group_not_project', 'group-not-project');
  }
  assertNotCopied(deps.store.getGroups(), source, target.id);
  const now = options.now ?? new Date().toISOString();
  const env = importEnvironment({
    provider: claude,
    scope: 'project',
    projectRoot: scope.path,
    override: options.override,
  });

  const warnings: CopyWarning[] = [];
  const only = new Set<string>();
  const members: GroupMember[] = [];
  /** Скилл-участник → запись среды: по ней видно, доехал ли он до цели. */
  const skillItems = new Map<string, string>();
  for (const member of source.members) {
    const content = memberContent(deps, memberScope(source, member), member);
    const command =
      member.kind === 'hook' && content
        ? (JSON.parse(content.text) as { command: string }).command
        : undefined;
    const item = content ? envItemFor(env, member, content.path, command) : undefined;
    if (!item) {
      warnings.push({ kind: 'skipped', member: memberKey(member), detail: member.kind });
      continue;
    }
    only.add(item.id);
    if (member.kind === 'skill') skillItems.set(member.id, item.id);
    members.push({ kind: member.kind, id: member.id });
  }

  const missed = new Set<string>();
  if (only.size > 0) {
    const { plan, writes } = buildTransferPlan(
      env,
      target,
      { scope: 'global', override: options.override },
      now,
      only,
    );
    // Запись, которую формат цели не принял, называется предупреждением, а не молча теряется.
    for (const entry of plan.entries) {
      if (!landsAtTarget(entry.outcome)) {
        missed.add(entry.itemId);
        warnings.push({ kind: 'skipped', member: entry.itemId, detail: entry.outcome });
      }
    }
    applyTransfer(plan.target, plan.root, writes, deps.backupDir);
    // Легло, но само не заработает: Codex запускает чужой хук только после
    // одобрения в своём `/hooks` (G3). Отчёт верности это знает, а копия молчала,
    // и человек считал бы хук действующим.
    for (const row of plan.report.rows) {
      if (row.condition === 'approve_in_cli' && only.has(row.itemId) && !missed.has(row.itemId)) {
        warnings.push({ kind: 'approve', member: row.itemId, detail: target.name });
      }
    }
  }

  // Числа — только у скиллов, которые цель приняла: у остальных их некому применить.
  const landed = new Map(
    [...skillItems].filter(([, itemId]) => !missed.has(itemId)).map(([id]) => [id, id]),
  );
  const knobs = carriedKnobs(source.knobs, landed);
  const { hashes, hash } = memberHashes(deps, source);
  const group: Group = {
    id: (options.makeId ?? randomUUID)(),
    name: source.name,
    description: source.description,
    color: source.color,
    icon: source.icon,
    members,
    env: {},
    projectPaths: [],
    // Каталоги цели, а не Claude: без провайдера копия читалась глобальной
    // группой Claude — тумблер гасил одноимённые скиллы Claude, а выбор пары
    // переводил проект Claude на группу без его файлов.
    scope: { kind: 'global', provider: target.id },
    origin: { scope, groupId: source.id, hash, memberHashes: hashes, copiedAt: now },
    ...(source.path ? { path: source.path } : {}),
    ...(source.flow ? { flow: source.flow } : {}),
    ...(source.when ? { when: source.when } : {}),
    ...(knobs ? { knobs } : {}),
    isEnabled: true,
    order: deps.store.getGroups().reduce((max, item) => Math.max(max, item.order), -1) + 1,
  };
  // Выбор пары проекта не трогаем: он решает, чей порядок работы берёт Claude в
  // проекте, а у копии для другой CLI в каталогах Claude файлов нет.
  return { group: deps.store.saveGroup(group), warnings };
}
