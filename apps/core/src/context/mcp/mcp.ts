import {
  CORE_MCP_SERVER,
  PERMIT_MCP_SERVER,
  toolPlanFor,
} from '@agentdeck/contracts/core/model-tools';
import { setHash } from '../base/base.ts';
import type { McpDropped, McpList, McpListInput, McpRouteFact } from './mcp.types.ts';

/**
 * Строгий список MCP по виду шага (03 §Context «per-step-kind MCP list (strict config)», P73;
 * порт `local-mcp` / `mcp-service` / `mcp-source` панели). Сервер ядра — всегда, его инструменты —
 * по плану вида (`toolPlanFor`: `check` только там, где код меняют или судят). Серверы человека —
 * только выбранные для этого вида (по умолчанию ни одного: замер панели 14.10 — gitlab из 39
 * инструментов стоил 15 тыс. токенов основы). Шаг только чтения (ревью, план, …) получает у
 * сервера человека лишь инструменты с `readOnlyHint`; список инструментов не прочитан — сервер
 * выпадает целиком: «читает» не доказано.
 *
 * Маршрут с известным окном (`route.context`) берёт серверы человека в порядке выбора, пока
 * после них остаётся запас на разговор (`окно − резерв сжатия − база − серверы ≥ 4000`); сервер
 * без замера цены на таком маршруте выпадает. Локальный маршрут без факта окна — ни одного
 * сервера человека: окно своей модели мало, а неизвестное не значит «влезет».
 */

/** Резерв сжатия Claude Code (замер панели на 2.1.286): `окно − min(вывод, 20000) − 13000`. */
export const COMPACT_RESERVE_TOKENS = 13_000;
/** Меньше на разговор не оставляют: сжатие шло бы на каждом ходе. */
export const MIN_HEADROOM_TOKENS = 4_000;

const full = (server: string, tool: string): string => `mcp__${server}__${tool}`;

export function mcpListFor(stepKind: string, route: McpRouteFact, input: McpListInput): McpList {
  const plan = toolPlanFor(stepKind);
  if (!plan) throw new Error(`step kind ${stepKind} has no model session: no MCP list`);
  const readOnly = plan.builtins === 'read-only';
  const allowedCore = new Set<string>(plan.modelTools);
  const deniedTools = input.coreTools
    .filter((t) => !allowedCore.has(t))
    .map((t) => full(CORE_MCP_SERVER, t));
  const servers = [CORE_MCP_SERVER, PERMIT_MCP_SERVER];
  const dropped: McpDropped[] = [];
  const window =
    route.contextTokens !== null
      ? route.contextTokens - COMPACT_RESERVE_TOKENS - input.baseTokens
      : null;
  let used = 0;
  const offers = new Map(input.offers.map((o) => [o.id, o]));
  for (const id of input.picks[stepKind] ?? []) {
    const offer = offers.get(id);
    if (!offer) {
      dropped.push({ id, reason: 'picked but not offered to this project' });
      continue;
    }
    if (id === CORE_MCP_SERVER || id === PERMIT_MCP_SERVER) {
      dropped.push({ id, reason: 'name taken by the core server' });
      continue;
    }
    if (readOnly && offer.tools === null) {
      dropped.push({
        id,
        reason: 'tool list unread: read-only step cannot prove the tools only read',
      });
      continue;
    }
    if (route.local && window === null) {
      dropped.push({ id, reason: `route ${route.id} context unknown: no room proven for MCP` });
      continue;
    }
    if (window !== null) {
      if (offer.tokens === null) {
        dropped.push({ id, reason: `cost unmeasured on route ${route.id} with a bounded window` });
        continue;
      }
      if (window - used - offer.tokens < MIN_HEADROOM_TOKENS) {
        dropped.push({
          id,
          reason: `would leave ${window - used - offer.tokens} tokens of route ${route.id} window (< ${MIN_HEADROOM_TOKENS})`,
        });
        continue;
      }
      used += offer.tokens;
    }
    servers.push(id);
    if (readOnly)
      for (const tool of offer.tools ?? [])
        if (tool.readOnly !== true) deniedTools.push(full(id, tool.name));
  }
  deniedTools.sort();
  return {
    stepKind,
    servers,
    deniedTools,
    dropped,
    headroom: window === null ? null : window - used,
    hash: setHash({ servers, deniedTools }),
  };
}
