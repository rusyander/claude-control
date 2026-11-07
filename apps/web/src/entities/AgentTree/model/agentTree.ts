import type { ProgressAgent } from '@agentdeck/contracts';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import type { AgentState, AgentTreeNode, TreeAgent } from './agentTree.types';

/**
 * Состояние субагента для показа. Фоновый живёт, пока жив процесс CLI
 * разговора: умер процесс — итога не будет, хотя транскрипт зовёт его
 * «работает» (живой прогон 14.10). Сервер без признака процесса — как было.
 * Вызов `Agent`, оборванный паузой или концом сессии, — тоже «оборван», не
 * «ошибка»: итога нет, но субагент не падал.
 */
export function agentState(
  agent: ProgressAgent,
  isRunning: boolean,
  processAlive: boolean | undefined = undefined,
): AgentState {
  if (agent.stopped) return 'stopped';
  if (agent.interrupted) return 'lost';
  if (agent.status === 'running' && !isRunning && processAlive === false) return 'lost';
  return agent.status;
}

/**
 * Дерево из плоского списка прогресса. Родитель — узел, чей `id` (вызов
 * `Agent`) назван в `parentId`; родителя в списке нет (середина большого
 * транскрипта не прочитана) — узел встаёт в корень, а не пропадает. Порядок —
 * как у сервера: по времени запуска.
 */
export function buildAgentTree(agents: readonly TreeAgent[]): AgentTreeNode[] {
  const byId = new Map<string, AgentTreeNode>();
  for (const agent of agents) byId.set(agent.id, { agent, level: 1, children: [] });
  const roots: AgentTreeNode[] = [];
  for (const agent of agents) {
    const node = byId.get(agent.id);
    if (!node) continue;
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    // Петля в данных (сам себе родитель) не должна уронить дерево.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const setLevels = (nodes: AgentTreeNode[], level: number, seen: Set<AgentTreeNode>): void => {
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      node.level = level;
      setLevels(node.children, level + 1, seen);
    }
  };
  setLevels(roots, 1, new Set());
  return roots;
}

/**
 * Видимые узлы в порядке обхода — то, по чему ходят стрелки дерева. Свёрнутый
 * узел прячет всю свою ветку.
 */
export function visibleNodes(
  roots: readonly AgentTreeNode[],
  collapsed: ReadonlySet<string>,
): AgentTreeNode[] {
  const out: AgentTreeNode[] = [];
  const walk = (nodes: readonly AgentTreeNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (!collapsed.has(node.agent.id)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Состояние узла ядра словами транскрипта: снятый — «остановлен», потерянный — «оборван». */
function progressStatus(
  node: AgentNode,
): Pick<ProgressAgent, 'status' | 'stopped' | 'interrupted'> {
  if (node.status === 'running') return { status: 'running' };
  if (node.status === 'completed') return { status: 'done' };
  if (node.status === 'killed' || node.status === 'stopped')
    return { status: 'failed', stopped: true };
  if (node.status === 'lost' || node.status === 'reaped')
    return { status: 'failed', interrupted: true };
  return { status: 'failed' };
}

/** Факты узла ядра поверх строки транскрипта: модель, вызовы, расход, конец, родитель. */
function withNode(
  agent: ProgressAgent,
  node: AgentNode,
  subagents: ReadonlySet<string>,
): TreeAgent {
  return {
    ...agent,
    ...(node.parentId !== null && subagents.has(node.parentId) ? { parentId: node.parentId } : {}),
    ...(node.model ? { model: node.model } : {}),
    toolCalls: node.counts.toolCalls,
    ...(node.spend.tokens !== null ? { spendTokens: node.spend.tokens } : {}),
    ...(node.endedAt !== null && agent.status !== 'running' ? { endedAt: iso(node.endedAt) } : {}),
  };
}

/**
 * Вложенный субагент, которого знает только ядро: его вызов — в чужом (субагентском) ходе. Имени
 * агента из транскрипта у него нет — `coreKind` подписывает строку словарём типов узлов ядра.
 */
function fromNode(node: AgentNode, subagents: ReadonlySet<string>): TreeAgent {
  const row = withNode(
    {
      id: node.nodeId,
      kind: node.kind,
      description: node.briefExcerpt?.split('\n')[0]?.trim() ?? '',
      ...progressStatus(node),
      ...(node.background ? { background: true } : {}),
      startedAt: iso(node.startedAt),
      ...(node.returnExcerpt ? { result: node.returnExcerpt } : {}),
    },
    node,
    subagents,
  );
  return { ...row, coreKind: node.kind };
}

/**
 * Дерево «Плана агента» с фактами ядра (этап 11, W3-17): транскрипты субагентов панель больше
 * не читает, поэтому сервер шлёт только вызовы `Agent` главного разговора. Модель, вызовы,
 * расход и конец строки берутся из узла ядра с тем же id (id вызова = `nodeId` субагента),
 * а субагенты, запущенные субагентами, добавляются веткой под родителем. Верхний субагент без
 * строки транскрипта (чат чужого CLI: его транскрипт панель не читает) встаёт узлом из ядра —
 * иначе «План агента» у чужого CLI был пуст, а других деревьев у него нет (F-07). Фоновые работы
 * и сеансы сюда не идут — у них своё окно «Агенты». Узлов ядра нет — строки как есть.
 */
export function withCoreFacts(
  agents: readonly ProgressAgent[],
  nodes: readonly AgentNode[],
): TreeAgent[] {
  const subagents = new Map<string, AgentNode>();
  for (const node of nodes) if (node.kind === 'subagent') subagents.set(node.nodeId, node);
  if (subagents.size === 0) return [...agents];
  const ids = new Set(subagents.keys());
  const out: TreeAgent[] = agents.map((agent) => {
    const node = subagents.get(agent.id);
    return node ? withNode(agent, node, ids) : agent;
  });
  const placed = new Set(out.map((agent) => agent.id));
  // Вложенные — по порядку запуска; ребёнок встаёт, как только его родитель уже в списке
  // (повторный проход — для ребёнка, чей родитель встал позже него).
  const rest = [...subagents.values()]
    .filter((node) => !placed.has(node.nodeId))
    .sort((a, b) => a.startedAt - b.startedAt);
  for (let added = true; added;) {
    added = false;
    for (const node of rest) {
      if (placed.has(node.nodeId)) continue;
      // Верхний субагент — его родитель не субагент (сеанс ядра или никто). Строки транскрипта у
      // него нет только в чате чужого CLI: транскрипт панель читает лишь у Claude (F-07).
      const top = node.parentId === null || !ids.has(node.parentId);
      if (!top && !placed.has(node.parentId ?? '')) continue;
      out.push(fromNode(node, ids));
      placed.add(node.nodeId);
      added = true;
    }
  }
  return out;
}

/** `claude-haiku-4-5-20251001` → `haiku-4-5`: в узле важна линейка, не дата сборки. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
