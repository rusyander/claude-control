import type { ProgressAgent } from '@agentdeck/contracts';
import type { AgentCounts, AgentState, AgentTreeNode } from './agentTree.types';

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
export function buildAgentTree(agents: readonly ProgressAgent[]): AgentTreeNode[] {
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

/** Сколько субагентов идёт и сколько закончило — для карточки группы. */
export function agentCounts(
  agents: readonly ProgressAgent[],
  isRunning: boolean,
  processAlive: boolean | undefined,
): AgentCounts {
  const states = agents.map((agent) => agentState(agent, isRunning, processAlive));
  const running = states.filter((state) => state === 'running').length;
  return { total: agents.length, running, finished: agents.length - running };
}

/** Весь расход субагента одним числом: вход, кэш и ответ. */
export function agentTokenTotal(agent: ProgressAgent): number {
  const tokens = agent.tokens;
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/** `claude-haiku-4-5-20251001` → `haiku-4-5`: в узле важна линейка, не дата сборки. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
