import type {
  PermissionDecision,
  PermissionDraft,
  PermissionRule,
  SettingsSource,
} from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import { LOCAL_ID_PREFIX } from '../lib/settings-source.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * Правила доступа из settings.json. Приоритет в Claude Code: deny > ask > allow,
 * поэтому одно и то же правило в разных списках ведёт себя по-разному — в
 * интерфейсе это показывается явно, чтобы не ловить сюрпризы.
 *
 * Инструменты MCP выглядят как `mcp__<сервер>__<инструмент>` — разбираем их
 * на части, чтобы правила можно было фильтровать по серверу.
 */

interface RawSettings {
  permissions?: Partial<Record<PermissionDecision, string[]>>;
  [key: string]: unknown;
}

const MCP_PATTERN = /^mcp__([^_]+(?:[^_]|_(?!_))*)__(.+)$/;

function readPermissionsFrom(
  settingsPath: string,
  store: AppStore,
  source: SettingsSource,
): PermissionRule[] {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const rules: PermissionRule[] = [];
  const prefix = source === 'settings-local' ? LOCAL_ID_PREFIX : '';

  for (const decision of ['allow', 'ask', 'deny'] as const) {
    for (const pattern of settings.permissions?.[decision] ?? []) {
      const id = `${prefix}${decision}:${pattern}`;
      const mcp = MCP_PATTERN.exec(pattern);

      rules.push({
        id,
        pattern,
        decision,
        mcpServer: mcp?.[1],
        mcpTool: mcp?.[2],
        groupIds: store.getGroupIdsFor('permission', id),
        source,
      });
    }
  }

  return rules;
}

/**
 * Все действующие права. Локальный файл читается наравне с основным — иначе
 * список врал бы: запрет, живущий в `settings.local.json`, действует ровно
 * так же, а в панели его не было видно вовсе.
 */
export function readPermissions(
  settingsPath: string,
  store: AppStore,
  localPath?: string,
): PermissionRule[] {
  const own = readPermissionsFrom(settingsPath, store, 'settings');
  if (!localPath) return own;

  return [...own, ...readPermissionsFrom(localPath, store, 'settings-local')];
}

export function savePermission(
  settingsPath: string,
  ruleId: string | null,
  draft: PermissionDraft,
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  settings.permissions ??= {};

  // Правило может переезжать между списками, поэтому сначала убираем старое.
  if (ruleId) {
    const [oldDecision, ...rest] = ruleId.split(':');
    const oldPattern = rest.join(':');
    const list = settings.permissions[oldDecision as PermissionDecision];
    if (list) {
      settings.permissions[oldDecision as PermissionDecision] = list.filter(
        (item) => item !== oldPattern,
      );
    }
  }

  const target = (settings.permissions[draft.decision] ??= []);
  if (!target.includes(draft.pattern)) target.push(draft.pattern);
  target.sort();

  return writeJsonFile(settingsPath, settings, { backupDir });
}

export function deletePermission(
  settingsPath: string,
  ruleId: string,
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const [decision, ...rest] = ruleId.split(':');
  const pattern = rest.join(':');
  const list = settings.permissions?.[decision as PermissionDecision];

  if (list && settings.permissions) {
    settings.permissions[decision as PermissionDecision] = list.filter((item) => item !== pattern);
  }

  return writeJsonFile(settingsPath, settings, { backupDir });
}
