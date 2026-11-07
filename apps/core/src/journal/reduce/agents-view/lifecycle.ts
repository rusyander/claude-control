import type { AgentStatus, BgItem } from '@agentdeck/contracts/core/agents';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AgentsFold, NodeAcc } from '../agents-view.types.ts';
import { contextNode, data, node } from './base.ts';

/**
 * Жизнь узлов: начало и конец сеанса, субагента, фоновой работы — при любом порядке и повторе строк.
 */

const SESSION_END: Readonly<Record<string, AgentStatus>> = {
  exited: 'completed',
  deadline: 'failed',
  'host-dead': 'lost',
};

const BG_STATUS: Readonly<Record<string, AgentStatus>> = { exit: 'completed' };

/**
 * Порядок строк узла: начало — один раз (повтор начала не обнуляет узел — расход, вызовы,
 * конец), конец — первый (поздний конец CLI после сноса ядром его не переименует), конец раньше
 * начала ждёт начала в `early`, а не теряется.
 */
function startOnce(fold: AgentsFold, nodeId: string): boolean {
  return !fold.nodes.has(nodeId);
}

function endFirst(fold: AgentsFold, l: JournalLine, nodeId: string): NodeAcc | undefined {
  const n = fold.nodes.get(nodeId);
  if (!n) {
    if (!fold.early.has(nodeId)) fold.early.set(nodeId, l);
    return undefined;
  }
  return n.endedAt === null ? n : undefined;
}

/** Конец, ждавший начала своего узла, — сразу за началом. */
function claimEarly(fold: AgentsFold, nodeId: string, touched: string[]): void {
  const end = fold.early.get(nodeId);
  if (!end) return;
  fold.early.delete(nodeId);
  if (end.kind === 'agent.ended') onAgent(fold, end, touched);
  else onBg(fold, end, touched);
}

export function onAgent(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  if (l.kind === 'agent.spawned') {
    const d = data(l, 'agent.spawned');
    if (!startOnce(fold, d.toolUseId)) return;
    const session = fold.sessions.get(d.sessionId);
    const parent = contextNode(fold, d.sessionId, d.parentToolUseId);
    const n = node(fold, {
      nodeId: d.toolUseId,
      parentId: parent?.nodeId ?? d.sessionId,
      kind: d.kind,
      stepId: session?.stepId ?? null,
      unitId: session ? (fold.steps.get(session.stepId)?.unitId ?? null) : null,
      sessionId: d.sessionId,
      model: d.model,
      effort: d.effort,
      background: d.background,
      startedAt: l.at,
      briefExcerpt: d.briefExcerpt,
      returnExcerpt: null,
      bg: null,
      startSeq: l.seq,
    });
    // Расход, пришедший раньше запуска своего вызова, — его, а не чужой.
    const pk = `${d.sessionId}:${d.toolUseId}`;
    const early = fold.pending.get(pk);
    if (early) {
      for (const [k, v] of early.usage) n.usage.set(k, v);
      fold.pending.delete(pk);
    }
    touched.push(n.nodeId, n.parentId ?? '');
    claimEarly(fold, n.nodeId, touched);
    // Запуск, записанный уже после конца своего сеанса, — сразу потерянный, с концом сеанса.
    const sessionEnd = session?.ended ? fold.nodes.get(d.sessionId)?.endedAt : null;
    if (typeof sessionEnd === 'number') endWithSession(fold, n, sessionEnd, touched);
    return;
  }
  const d = data(l, 'agent.ended');
  const n = endFirst(fold, l, d.toolUseId);
  if (!n) return;
  n.status = d.how;
  n.endedAt = l.at;
  n.endTokens = d.usage?.totalTokens ?? null;
  n.returnExcerpt = d.summaryExcerpt;
  touched.push(n.nodeId);
}

export function onBg(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  if (l.kind === 'bg.started') {
    const d = data(l, 'bg.started');
    if (!startOnce(fold, d.itemId)) return;
    const c = d.ownerChain;
    const parent = contextNode(fold, c.sessionId, c.parentToolUseId);
    const item: BgItem = { ...d };
    const n = node(fold, {
      nodeId: d.itemId,
      parentId: parent?.nodeId ?? c.sessionId,
      kind: d.kind,
      stepId: c.stepId,
      unitId: c.unitId,
      sessionId: c.sessionId,
      model: null,
      effort: null,
      background: true,
      startedAt: d.startedAt,
      briefExcerpt: d.excerpt,
      returnExcerpt: null,
      bg: item,
      startSeq: l.seq,
    });
    touched.push(n.nodeId, n.parentId ?? '');
    claimEarly(fold, n.nodeId, touched);
    return;
  }
  const d = data(l, 'bg.ended');
  const n = endFirst(fold, l, d.itemId);
  if (!n?.bg) return;
  n.status = BG_STATUS[d.how] ?? (d.how as AgentStatus);
  n.endedAt = d.endedAt;
  n.returnExcerpt = d.summary ?? null;
  n.bg = {
    ...n.bg,
    endedAt: d.endedAt,
    how: d.how,
    // Код выхода — для «завершён (код 0)» на экране: статус `completed` его не несёт.
    ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
  };
  touched.push(n.nodeId);
}

export function onSession(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  if (l.kind === 'session.started') {
    const d = data(l, 'session.started');
    if (!startOnce(fold, d.sessionId)) return;
    fold.sessions.set(d.sessionId, {
      sessionId: d.sessionId,
      stepId: d.stepId,
      host: d.hostPid > 0 ? { pid: d.hostPid, start: d.hostStart } : null,
      ended: false,
    });
    node(fold, {
      nodeId: d.sessionId,
      parentId: null,
      kind: 'unit-session',
      stepId: d.stepId,
      unitId: fold.steps.get(d.stepId)?.unitId ?? null,
      sessionId: d.sessionId,
      model: d.modelServed ?? d.modelAsked,
      effort: d.effort,
      background: false,
      startedAt: l.at,
      briefExcerpt: null,
      returnExcerpt: null,
      bg: null,
      startSeq: l.seq,
    });
    touched.push(d.sessionId);
    return;
  }
  const d = data(l, 'session.transition');
  const n = fold.nodes.get(d.sessionId);
  const s = fold.sessions.get(d.sessionId);
  if (!n || !s || s.ended || (d.to !== 'ended' && d.to !== 'lost')) return;
  s.ended = true;
  n.status = SESSION_END[d.event] ?? (d.to === 'lost' ? 'lost' : 'completed');
  n.endedAt = l.at;
  touched.push(n.nodeId);
  for (const other of fold.nodes.values())
    if (other.sessionId === d.sessionId && !other.bg) endWithSession(fold, other, l.at, touched);
}

/**
 * Конец сеанса — конец всего, что шло в его CLI (CLI упал или хост умер посреди субагента — своего
 * конца у них не будет): субагент без конца — `lost` с концом сеанса, вызов без результата — с
 * длительностью до конца сеанса и неизвестным исходом. В самой свёртке, не только в виде: дерево,
 * фильтр, поток и сторож видят одно. Фоновая работа сюда не входит — её снимает сторож фона.
 */
function endWithSession(fold: AgentsFold, n: NodeAcc, at: number, touched: string[]): void {
  let moved = false;
  for (const id of n.calls) {
    const c = fold.calls.get(id);
    if (!c || c.ms !== null || c.denied || c.startedAt === null) continue;
    c.ms = Math.max(0, at - c.startedAt);
    moved = true;
  }
  if (n.kind !== 'unit-session' && n.status === 'running') {
    n.status = 'lost';
    n.endedAt = at;
    moved = true;
  }
  if (moved && !touched.includes(n.nodeId)) touched.push(n.nodeId);
}
