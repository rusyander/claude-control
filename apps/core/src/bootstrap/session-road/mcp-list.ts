import { MODEL_TOOL_NAMES, toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { DenySet } from '../../adapters/adapter.types.ts';
import { mcpListFor, type McpList } from '../../context/mcp/index.ts';

/**
 * Строгий список MCP сеанса на дороге (P73, C `mcpListFor`): серверы — только из списка вида
 * шага, инструменты ядра не своего вида — в запреты MCP (оверлей CLI и судья права видят один
 * набор, F-11), отпечаток списка — `mcpHash` ключа замера базы (G9). Серверов человека дорога
 * пока не предлагает (нет чтения предложений проекта) — в списке только ядро и право.
 */

/** Список вида шага; у вида без сессии модели (`check`, `publish`) — `null`: дорога их не ведёт. */
export function sessionMcpList(stepKind: string, routeId: string): McpList | null {
  if (!toolPlanFor(stepKind)) return null;
  return mcpListFor(
    stepKind,
    // Окно и локальность судят только серверы человека, а их дорога пока не предлагает: факт
    // маршрута здесь ни на что не влияет — когда появятся предложения, сюда придёт `route.context`.
    { id: routeId, local: false, contextTokens: null },
    { offers: [], picks: {}, baseTokens: 0, coreTools: MODEL_TOOL_NAMES },
  );
}

/** Запреты шага + запреты списка, без повторов. */
export function withMcpDeny(deny: DenySet, list: McpList | null): DenySet {
  if (!list || list.deniedTools.length === 0) return deny;
  return { ...deny, mcpTools: [...new Set([...deny.mcpTools, ...list.deniedTools])] };
}

/** Записи серверов только из списка; списка нет — все. */
export function strictServers<E>(all: Record<string, E>, list: McpList | null): Record<string, E> {
  if (!list) return all;
  const keep = new Set(list.servers);
  return Object.fromEntries(Object.entries(all).filter(([name]) => keep.has(name)));
}
