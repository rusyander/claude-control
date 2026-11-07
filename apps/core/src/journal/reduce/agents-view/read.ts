import type {
  AgentNode,
  AgentNodeDetail,
  AgentsQuery,
  AgentTreeView,
  BgItem,
} from '@agentdeck/contracts/core/agents';
import type { AgentsFold, NodeAcc } from '../agents-view.types.ts';

/**
 * Вид свёртки истории агентов (P146): узел, дерево с фильтрами, узел подробно. Расход узла —
 * сумма его строк расхода, без них — итог CLI на конце субагента, без того — `null`
 * («неизвестно»): ноль не выдумывается. Субагент без конца при кончившемся сеансе уже потерянный
 * (`lost`) в самой свёртке (`endWithSession`): вид его не пересчитывает.
 */

/** Вызовов на страницу подробного вида. */
export const AGENT_CALLS_PAGE = 100;

const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

function escalationsOf(fold: AgentsFold, n: NodeAcc) {
  return n.kind === 'unit-session' && n.stepId ? (fold.escalations.get(n.stepId) ?? []) : [];
}

export function agentNodeOf(fold: AgentsFold, nodeId: string): AgentNode | undefined {
  const n = fold.nodes.get(nodeId);
  if (!n) return undefined;
  let children = 0;
  for (const other of fold.nodes.values()) if (other.parentId === nodeId) children += 1;
  return {
    nodeId: n.nodeId,
    parentId: n.parentId,
    taskId: fold.taskId,
    kind: n.kind,
    status: n.status,
    endedAt: n.endedAt,
    stepId: n.stepId,
    unitId: n.unitId,
    sessionId: n.sessionId,
    model: n.model,
    effort: n.effort,
    background: n.background,
    startedAt: n.startedAt,
    spend: {
      tokens: n.usage.size > 0 ? sum(n.usage) : n.endTokens,
      windowShare: n.windowShare,
    },
    counts: {
      toolCalls: n.calls.length,
      files: n.files.length,
      refusals: n.refusals.length,
      escalations: escalationsOf(fold, n).length,
      children,
    },
    signals: n.signals.slice(0, 50),
    briefExcerpt: n.briefExcerpt?.slice(0, 2000) ?? null,
    returnExcerpt: n.returnExcerpt?.slice(0, 2000) ?? null,
    ...(n.bg?.exitCode !== undefined ? { exitCode: n.bg.exitCode } : {}),
  };
}

function matches(node: AgentNode, query: AgentsQuery): boolean {
  if (query.status && node.status !== query.status) return false;
  if (query.model && node.model !== query.model) return false;
  if (query.kind && node.kind !== query.kind) return false;
  return true;
}

/** Дерево задачи: узлы по порядку появления в журнале; фильтр класса — по классу задачи. */
export function agentTreeOf(fold: AgentsFold, query: AgentsQuery = {}): AgentTreeView {
  const classOk = !query.class || fold.class === query.class;
  const nodes = classOk
    ? [...fold.nodes.keys()]
        .map((id) => agentNodeOf(fold, id) as AgentNode)
        .filter((n) => matches(n, query))
    : [];
  return { taskId: fold.taskId, seq: fold.seq, class: fold.class, nodes };
}

function pageStart(page: string | null, total: number): number {
  // Курсор проверен маршрутом (`pageCursor`); за концом — пустая страница, а не снова первая.
  const at = page === null ? 0 : Number(page);
  return Number.isInteger(at) && at >= 0 ? Math.min(at, total) : 0;
}

/**
 * Узел подробно. `outputTail` — хвост файла вывода, уже замаскированный вызывающим (чтение идёт
 * через `platform` при показе, в журнал не пишется); `null` — нет файла или узел не фоновый.
 */
export function agentDetailOf(
  fold: AgentsFold,
  nodeId: string,
  page: string | null,
  outputTail: AgentNodeDetail['outputTail'],
): AgentNodeDetail | undefined {
  const view = agentNodeOf(fold, nodeId);
  const n = fold.nodes.get(nodeId);
  if (!view || !n) return undefined;
  const start = pageStart(page, n.calls.length);
  const ids = n.calls.slice(start, start + AGENT_CALLS_PAGE);
  const end = start + ids.length;
  const bg: BgItem[] = [];
  if (n.bg) bg.push(n.bg);
  for (const other of fold.nodes.values())
    if (other.parentId === nodeId && other.bg) bg.push(other.bg);
  return {
    node: view,
    toolCalls: {
      items: ids.flatMap((id) => {
        const c = fold.calls.get(id);
        if (!c) return [];
        const { nodeId: _n, effectClass: _e, ...call } = c;
        return [{ ...call, target: call.target.slice(0, 2000) }];
      }),
      next: end < n.calls.length ? String(end) : null,
    },
    files: n.files.slice(0, 1000),
    refusals: n.refusals,
    escalations: escalationsOf(fold, n),
    bg,
    outputTail: n.bg ? outputTail : null,
  };
}
