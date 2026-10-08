import type { Overview, ProviderHooksInfo, ProviderPermissionInfo } from '@agentdeck/contracts';
import type { ConfigProvider } from '../providers/types/types.ts';
import type { AppStore } from '../lib/app-store/app-store.ts';
import { readProviderMcpSection, resolveProviderMcpTarget } from './provider-mcp/provider-mcp.ts';
import {
  readProviderHooksInfo,
  resolveProviderHooksTarget,
} from './provider-hooks/provider-hooks.ts';
import {
  readProviderSkillsInfo,
  resolveProviderSkillsTarget,
} from './provider-skills/provider-skills.ts';
import {
  readProviderRulesInfo,
  resolveProviderRulesTarget,
} from './provider-rules/provider-rules.ts';
import {
  buildProviderPermissionInfo,
  resolveProviderPermissionsTarget,
} from './provider-permissions/provider-permissions.ts';

type SectionCounts = Pick<Overview, 'rules' | 'hooks' | 'skills' | 'mcp' | 'permissions'>;

/**
 * Счётчики обзора для НЕ-Claude провайдера — через те же адаптеры, что и его
 * разделы (`readProvider<X>Info`), иначе обзор и раздел расходились бы в цифрах.
 * Раздела у провайдера нет (резолвер вернул `undefined`) или файл не разобран —
 * `null`: плитку не рисуем, а не показываем ноль, которого нет.
 *
 * Здоровья MCP-серверов и выключенных записей у чужих форматов панель не знает:
 * «включено» = всего, «подключено/упало» = 0.
 */
export function buildProviderSectionCounts(store: AppStore): SectionCounts {
  return {
    rules: countOrNull(() => {
      const target = resolveProviderRulesTarget(store);
      if (!target) return null;
      const total = readProviderRulesInfo(target).rules.length;
      return { total, enabled: total };
    }),
    hooks: countOrNull(() => {
      const target = resolveProviderHooksTarget(store);
      if (!target) return null;
      const total = countHooks(readProviderHooksInfo(target));
      return { total, enabled: total, broken: 0 };
    }),
    skills: countOrNull(() => {
      const target = resolveProviderSkillsTarget(store);
      if (!target) return null;
      const total = readProviderSkillsInfo(target).skills.length;
      return { total, enabled: total };
    }),
    mcp: countOrNull(() => {
      const target = resolveProviderMcpTarget(store);
      if (!target) return null;
      const total = readProviderMcpSection(target).servers.length;
      return { total, enabled: total, connected: 0, failed: 0 };
    }),
    permissions: countOrNull(() => {
      const target = resolveProviderPermissionsTarget(store);
      return target ? countPermissions(buildProviderPermissionInfo(target)) : null;
    }),
  };
}

/** Описание провайдера для подписи обзора. */
export function overviewProvider(provider: ConfigProvider): Overview['provider'] {
  return { id: provider.id, name: provider.name };
}

/** Нечитаемый файл раздела — не повод ронять весь обзор: этот счётчик просто пуст. */
function countOrNull<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function countHooks(info: ProviderHooksInfo): number {
  if (info.shape === 'event-rules') return info.rules.length;
  return (
    info.fileEdited.reduce((sum, group) => sum + group.actions.length, 0) +
    info.sessionCompleted.length
  );
}

/**
 * Разрешить / спросить / запретить — только там, где формат хранит СПИСКИ правил.
 * Codex и Goose задают один режим без списков: сумма по ним ничего не значит.
 */
export function countPermissions(
  info: ProviderPermissionInfo,
): { allow: number; ask: number; deny: number } | null {
  switch (info.kind) {
    case 'qwen':
      return { allow: info.allow.length, ask: info.ask.length, deny: info.deny.length };
    case 'continue':
      return { allow: info.allow.length, ask: info.ask.length, deny: info.exclude.length };
    case 'cursor':
      return { allow: info.allow.length, ask: 0, deny: info.deny.length };
    case 'gemini':
      return { allow: info.coreTools.length, ask: 0, deny: info.excludeTools.length };
    case 'kimi':
      return tally(info.rules.map((rule) => rule.decision));
    case 'opencode':
      return tally(
        info.entries.flatMap((entry) => {
          if (entry.mode === 'patterns') return (entry.patterns ?? []).map((rule) => rule.level);
          return entry.level ? [entry.level] : [];
        }),
      );
    case 'codex':
    case 'goose':
      return null;
  }
}

function tally(levels: readonly ('allow' | 'ask' | 'deny')[]): {
  allow: number;
  ask: number;
  deny: number;
} {
  return {
    allow: levels.filter((level) => level === 'allow').length,
    ask: levels.filter((level) => level === 'ask').length,
    deny: levels.filter((level) => level === 'deny').length,
  };
}
