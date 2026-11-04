import { MODEL_TOOL_NAMES, toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { DenySet, McpServerEntry } from '../../adapters/adapter.types.ts';
import { forgeMcpServers, type ForgeServer } from '../../adapters/forge/mcp-tools.ts';
import type { McpSourceRead } from '../../adapters/mcp-source/mcp-source.ts';
import { mcpListFor, type McpList, type McpOffer } from '../../context/mcp/index.ts';
import { readCoreConfig, sectionProblem } from '../../platform/core-config/read.ts';

/**
 * Строгий список MCP сеанса на дороге (P73, C `mcpListFor`): ядро и право — всегда, серверы
 * человека — только предложенные CLI сеанса (`adapter.mcpSource`: его конфиг MCP в его порядке
 * пользователь/проект) И выбранные человеком для вида шага (`config.mcpPicks`). Инструменты
 * ядра не своего вида — в запреты MCP (оверлей CLI и судья права видят один набор, F-11),
 * отпечаток списка — `mcpHash` ключа замера базы (G9).
 *
 * Инструменты сервера человека дорога не перечисляет (это запуск чужого процесса до сеанса):
 * `tools: null` — шаг только чтения такой сервер не получит («читает» не доказано), цена не
 * замерена — маршрут с известным окном его тоже не возьмёт; оба выпадения названы в `dropped`.
 * Значения `env` выбранных серверов уходят переходнику, в журнал — только имена и причины.
 */

export type McpPicks = Readonly<Partial<Record<string, readonly string[]>>>;

export interface SessionMcp {
  list: McpList | null;
  /** Выбранные серверы человека, прошедшие список: имя → запуск (в `mcpServers` шага). */
  human: Record<string, McpServerEntry>;
  /**
   * Выбранные серверы человека, говорящие с форжем (`forge-mcp-read-only`, P82): в сеансе только
   * чтение — запреты платформы шага несут их имена судье права и хуку ядра.
   */
  forge: ForgeServer[];
  /** Строка журнала: предложено / выбрано / выпало и почему; нечего сказать — `null`. */
  note: string | null;
}

/** Выбор человека из конфига ядра; раздел не прошёл схему — пусто, причина названа. */
export function mcpPicksFor(configPath: string): { picks: McpPicks; problem?: string } {
  const read = readCoreConfig({ config: configPath });
  if ('absent' in read) return { picks: {} };
  if ('unknown' in read) return { picks: {}, problem: `core config unreadable: ${read.unknown}` };
  const problem = sectionProblem(read.value, 'mcpPicks');
  if (problem) return { picks: {}, problem };
  return { picks: read.value.doc.mcpPicks ?? {} };
}

function noteOf(
  source: McpSourceRead | null,
  list: McpList | null,
  picked: string[],
  byDefault = false,
  forge: readonly ForgeServer[] = [],
): string | null {
  if (!source || !list) return null;
  const parts: string[] = [];
  const offered = source.servers.filter((s) => s.entry).map((s) => `${s.id}(${s.scope})`);
  if (offered.length > 0) parts.push(`offered: ${offered.join(', ')}`);
  if (picked.length > 0)
    parts.push(`${byDefault ? 'picked by default (chat)' : 'picked'}: ${picked.join(', ')}`);
  if (forge.length > 0)
    parts.push(`forge read-only: ${forge.map((f) => `${f.id} (${f.why})`).join(', ')}`);
  for (const d of list.dropped) parts.push(`dropped ${d.id}: ${d.reason}`);
  for (const s of source.servers) if (s.skipped) parts.push(`not offered ${s.id}: ${s.skipped}`);
  for (const u of source.unread) parts.push(`unread ${u.file}: ${u.reason}`);
  if (source.projectSkipped && parts.length > 0) parts.push(source.projectSkipped);
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Список вида шага с предложениями CLI и выбором человека. Вид без сессии модели (`check`,
 * `publish`) — `list: null`: дорога их не ведёт.
 */
export function sessionMcp(
  stepKind: string,
  routeId: string,
  source: McpSourceRead | null = null,
  picks: McpPicks = {},
  forgeHosts: readonly string[] = [],
): SessionMcp {
  if (!toolPlanFor(stepKind)) return { list: null, human: {}, forge: [], note: null };
  const entries = new Map<string, McpServerEntry>();
  const offers: McpOffer[] = [];
  for (const server of source?.servers ?? []) {
    if (!server.entry) continue;
    entries.set(server.id, server.entry);
    offers.push({ id: server.id, tools: null, tokens: null });
  }
  // Паритет чата панели (s10 p8): старый чат шёл без `--strict-mcp-config` — CLI поднимал все
  // серверы человека. Нет `mcpPicks.chat` — выбраны все предложенные; есть — ровно он (пустой —
  // ни одного). Прочие виды — только явный выбор (P73).
  const byDefault = stepKind === CHAT_KIND && picks[CHAT_KIND] === undefined;
  const effective: McpPicks = byDefault
    ? { ...picks, [CHAT_KIND]: offers.map((o) => o.id) }
    : picks;
  const list = mcpListFor(
    stepKind,
    // Окно маршрута дорога пока не знает (`route.context` не доходит сюда): «неизвестно» —
    // серверы человека судятся только видом шага; локальный маршрут — своей веткой ниже.
    { id: routeId, local: false, contextTokens: null },
    { offers, picks: effective, baseTokens: 0, coreTools: MODEL_TOOL_NAMES },
  );
  const human: Record<string, McpServerEntry> = {};
  for (const id of list.servers) {
    const entry = entries.get(id);
    if (entry) human[id] = entry;
  }
  const forge = forgeMcpServers(human, forgeHosts);
  return { list, human, forge, note: noteOf(source, list, Object.keys(human), byDefault, forge) };
}

/** Вид шага чата панели (chat@1): его выбор по умолчанию — все предложенные серверы. */
export const CHAT_KIND = 'chat';

/** Только список (без предложений): вид шага и маршрут. */
export function sessionMcpList(stepKind: string, routeId: string): McpList | null {
  return sessionMcp(stepKind, routeId).list;
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
