import {
  LOCAL_LEAN_BASE_TOKENS,
  localMcpHeadroom,
  type LocalMcpInfo,
  type LocalMcpServer,
} from '@agentdeck/contracts/local-models';
import {
  costKeyOf,
  fingerprintOf,
  measureEntry,
  needsMeasure,
  projectKeyOf,
  type LocalMcpSource,
  type McpCostRecord,
  type McpSourceEntry,
} from './local-mcp.ts';
import { localCompactAt } from './run-env.ts';
import type { LocalState } from './paths.ts';

/**
 * MCP-серверы локального прогона одной службой: список проекта с ценой каждого,
 * выбор человека (по проекту, помнится между запусками) и то, что идёт прогону.
 * Диск и сервер моделей приходят снаружи — сюда не входит ни тот, ни другой.
 */

export interface LocalMcpServiceDeps {
  source: LocalMcpSource;
  read: () => LocalState;
  update: (change: (state: LocalState) => void) => void;
  /** Окно сервера моделей, а пока он не поднят — наименьшее окно агента. */
  context: () => number;
  /** Счёт токенов сервера моделей для набора инструментов; нет сервера — не задан. */
  count?: () => Promise<((tools: unknown[]) => Promise<number>) | undefined>;
  now?: () => Date;
}

/** Что идёт прогону: записи выбранных серверов для `--mcp-config` и их имена. */
export interface LocalMcpRun {
  ids: string[];
  config: { mcpServers: Record<string, Record<string, unknown>> };
}

export function createLocalMcp(deps: LocalMcpServiceDeps) {
  const now = (): Date => deps.now?.() ?? new Date();

  /** Выбор проекта, очищенный от серверов, которых в файлах больше нет. */
  function pickedOf(project: string, entries: McpSourceEntry[]): string[] {
    const known = new Set(entries.map((entry) => entry.id));
    return (deps.read().mcpPicks[projectKeyOf(project)] ?? []).filter((id) => known.has(id));
  }

  function describe(project: string): LocalMcpInfo {
    const entries = deps.source.list(project);
    const state = deps.read();
    const picked = pickedOf(project, entries);
    const chosen = new Set(picked);
    const servers: LocalMcpServer[] = entries.map((entry) => {
      const cost: McpCostRecord | undefined = state.mcpCosts[costKeyOf(entry)];
      // Запись о ДРУГОЙ записи сервера (команду или адрес поменяли) цены не даёт.
      const fresh = cost?.fingerprint === fingerprintOf(entry) ? cost : undefined;
      return {
        id: entry.id,
        scope: entry.scope,
        transport: entry.transport,
        tokens: fresh?.tokens ?? null,
        tools: fresh?.tools ?? null,
        ...(fresh?.source ? { source: fresh.source } : {}),
        ...(fresh?.error ? { error: fresh.error } : {}),
        picked: chosen.has(entry.id),
      };
    });
    const base = {
      compactAt: localCompactAt(deps.context()),
      baseTokens: LOCAL_LEAN_BASE_TOKENS,
      servers,
    };
    return {
      project,
      context: deps.context(),
      compactAt: base.compactAt,
      baseTokens: base.baseTokens,
      headroom: localMcpHeadroom(base, picked),
      servers,
      picked,
    };
  }

  return {
    describe,

    /**
     * Замерить серверы проекта: названные в `ids` — все, остальное — только те,
     * у которых цены нет. Сервер, что не ответил, получает запись с причиной и не
     * мешает остальным.
     *
     * Без `ids` (замер при открытии списка) проектные серверы не трогаются: замер
     * запускает команду из `.mcp.json`, а Claude Code такую запускает только после
     * одобрения человеком. Проектный сервер замеряется лишь по явной просьбе.
     */
    async measure(project: string, ids?: string[]): Promise<LocalMcpInfo> {
      const entries = deps.source.list(project);
      const count = await deps.count?.();
      const forced = ids ? new Set(ids) : undefined;
      const state = deps.read();
      const todo = entries.filter((entry) =>
        forced
          ? forced.has(entry.id)
          : entry.scope !== 'project' &&
            needsMeasure(state.mcpCosts[costKeyOf(entry)], entry, {
              serverCounts: Boolean(count),
              now: now().getTime(),
            }),
      );
      const records = await Promise.all(
        todo.map(async (entry) => {
          const record = await measureEntry({
            entry,
            source: deps.source,
            ...(count ? { count } : {}),
            now,
          });
          return [costKeyOf(entry), record] as const;
        }),
      );
      if (records.length)
        deps.update((next) => {
          for (const [key, record] of records) next.mcpCosts[key] = record;
        });
      return describe(project);
    },

    /** Запомнить выбор проекта. Неизвестные серверы отбрасываются, повторы — тоже. */
    pick(project: string, servers: string[]): LocalMcpInfo {
      const known = new Set(deps.source.list(project).map((entry) => entry.id));
      const next = [...new Set(servers)].filter((id) => known.has(id));
      deps.update((state) => {
        const key = projectKeyOf(project);
        if (next.length) state.mcpPicks[key] = next;
        else delete state.mcpPicks[key];
      });
      return describe(project);
    },

    /** Выбранное для прогона в этом проекте; ничего не выбрано — `undefined`, прогон идёт как раньше. */
    run(project: string): LocalMcpRun | undefined {
      const entries = deps.source.list(project);
      const picked = pickedOf(project, entries);
      if (!picked.length) return undefined;
      const mcpServers: Record<string, Record<string, unknown>> = {};
      for (const entry of entries)
        if (picked.includes(entry.id)) mcpServers[entry.id] = entry.config;
      return { ids: picked, config: { mcpServers } };
    },
  };
}
