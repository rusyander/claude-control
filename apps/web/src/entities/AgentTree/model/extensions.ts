import type {
  AgentExtensionKind,
  AgentExtensionSummary,
  AgentExtensionUse,
} from '@agentdeck/contracts';
import type { ExtensionChip, ExtensionTotals } from './extensions.types';

/** Порядок групп везде одинаковый: скиллы, MCP, хуки. */
export const EXTENSION_KINDS: readonly AgentExtensionKind[] = ['skill', 'mcp', 'hook'];

/** Сколько скиллов назвать в значках узла: дальше — в окне. */
const SKILL_CHIPS = 3;
const MCP_CHIPS = 2;

/** Итоги по видам: сколько срабатываний и сколько отказов хуков. */
export function extensionTotals(
  summary: readonly AgentExtensionSummary[] | undefined,
): ExtensionTotals {
  const totals: ExtensionTotals = { skill: 0, mcp: 0, hook: 0, denied: 0, errors: 0 };
  for (const row of summary ?? []) {
    totals[row.kind] += row.count;
    totals.denied += row.denied ?? 0;
    totals.errors += row.errors ?? 0;
  }
  return totals;
}

/** Сводки нескольких агентов в одну — карточка группы считает всех сразу. */
export function mergeSummaries(
  lists: readonly (readonly AgentExtensionSummary[] | undefined)[],
): AgentExtensionSummary[] {
  const merged = new Map<string, AgentExtensionSummary>();
  for (const list of lists) {
    for (const row of list ?? []) {
      const key = `${row.kind}\u0000${row.name}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { ...row });
        continue;
      }
      prev.count += row.count;
      const totalMs = (prev.totalMs ?? 0) + (row.totalMs ?? 0);
      if (totalMs > 0) prev.totalMs = totalMs;
      const denied = (prev.denied ?? 0) + (row.denied ?? 0);
      if (denied > 0) prev.denied = denied;
      const errors = (prev.errors ?? 0) + (row.errors ?? 0);
      if (errors > 0) prev.errors = errors;
      if (row.lastAt && (!prev.lastAt || row.lastAt > prev.lastAt)) prev.lastAt = row.lastAt;
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      EXTENSION_KINDS.indexOf(a.kind) - EXTENSION_KINDS.indexOf(b.kind) || b.count - a.count,
  );
}

/**
 * Значки строки агента: скиллы по именам, MCP по серверам, хуки одним числом
 * и отказы хуков отдельно — их ищут глазами первыми.
 */
export function extensionChips(
  summary: readonly AgentExtensionSummary[] | undefined,
): ExtensionChip[] {
  const rows = summary ?? [];
  const chips: ExtensionChip[] = [];
  const skills = rows.filter((row) => row.kind === 'skill');
  for (const row of skills.slice(0, SKILL_CHIPS)) {
    chips.push({ kind: 'skill', label: row.name, count: row.count });
  }
  if (skills.length > SKILL_CHIPS) {
    chips.push({ kind: 'skill', label: '', count: skills.length - SKILL_CHIPS, more: true });
  }
  const servers = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'mcp') continue;
    const server = row.name.split('/')[0] ?? row.name;
    servers.set(server, (servers.get(server) ?? 0) + row.count);
  }
  const byServer = [...servers.entries()].sort((a, b) => b[1] - a[1]);
  for (const [server, count] of byServer.slice(0, MCP_CHIPS)) {
    chips.push({ kind: 'mcp', label: server, count });
  }
  if (byServer.length > MCP_CHIPS) {
    chips.push({ kind: 'mcp', label: '', count: byServer.length - MCP_CHIPS, more: true });
  }
  const totals = extensionTotals(rows);
  if (totals.hook > 0) chips.push({ kind: 'hook', label: '', count: totals.hook });
  if (totals.denied > 0) chips.push({ kind: 'denied', label: '', count: totals.denied });
  return chips;
}

/** Срабатывания по видам, внутри — по времени, как в транскрипте. */
export function groupByKind(
  items: readonly AgentExtensionUse[],
): Record<AgentExtensionKind, AgentExtensionUse[]> {
  const groups: Record<AgentExtensionKind, AgentExtensionUse[]> = { skill: [], mcp: [], hook: [] };
  for (const item of items) groups[item.kind].push(item);
  return groups;
}
