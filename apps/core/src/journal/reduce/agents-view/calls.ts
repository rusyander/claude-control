import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AgentsFold, CallAcc, NodeAcc } from '../agents-view.types.ts';
import { contextNode, data, isClass, sum, usageTokens } from './base.ts';

/**
 * Строки работы внутри узлов: расход (`turn.usage` по `parentToolUseId`), вызовы
 * (`tool.started` + `tool.event`), отказы и подъёмы ступени (`decision`), сигналы.
 */

function rung(model: unknown, effort: unknown): string {
  return `${typeof model === 'string' ? model : 'cli-default'}·${typeof effort === 'string' ? effort : 'default'}`;
}

export function onUsage(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  const u = data(l, 'turn.usage');
  const key = `${u.sessionId}|${u.messageId}`;
  const tokens = usageTokens(u);
  const parent = u.parentToolUseId;
  // Строка без поля у субагента — родитель не назван: расход узла неизвестен, а не сеанса.
  if (parent === undefined && u.subagent) return;
  const target = typeof parent === 'string' ? fold.nodes.get(parent) : fold.nodes.get(u.sessionId);
  if (typeof parent === 'string' && (!target || target.sessionId !== u.sessionId || target.bg)) {
    const pk = `${u.sessionId}:${parent}`;
    const p = fold.pending.get(pk) ?? {
      sessionId: u.sessionId,
      parentToolUseId: parent,
      seqs: [],
      tokens: 0,
      usage: new Map<string, number>(),
    };
    p.usage.set(key, tokens);
    p.seqs.push(l.seq);
    p.tokens = sum(p.usage);
    fold.pending.set(pk, p);
    return;
  }
  if (!target) return;
  target.usage.set(key, tokens);
  if (u.contextWindow)
    target.windowShare = Math.min(1, (u.input + u.cacheRead + u.cacheWrite) / u.contextWindow);
  touched.push(target.nodeId);
}

export function onCall(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  if (l.kind === 'tool.started') {
    const d = data(l, 'tool.started');
    const owner = contextNode(fold, d.sessionId, d.parentToolUseId);
    if (!owner) return;
    const call: CallAcc = fold.calls.get(d.toolUseId) ?? {
      toolUseId: d.toolUseId,
      tool: d.tool,
      target: d.target,
      startedAt: l.at,
      ms: null,
      isError: null,
      denied: false,
      nodeId: owner.nodeId,
      effectClass: null,
    };
    call.startedAt ??= l.at;
    if (!fold.calls.has(d.toolUseId)) owner.calls.push(d.toolUseId);
    fold.calls.set(d.toolUseId, call);
    touched.push(owner.nodeId);
    rehome(fold, d.toolUseId, owner, touched);
    return;
  }
  const d = data(l, 'tool.event');
  const known = fold.calls.get(d.toolUseId);
  const owner = known
    ? fold.nodes.get(known.nodeId)
    : contextNode(fold, d.sessionId, d.parentToolUseId);
  if (!owner) return;
  const call: CallAcc = known ?? {
    toolUseId: d.toolUseId,
    tool: d.tool,
    target: d.target.slice(0, 2000),
    startedAt: null,
    ms: null,
    isError: null,
    denied: false,
    nodeId: owner.nodeId,
    effectClass: null,
  };
  if (!known) owner.calls.push(d.toolUseId);
  fold.calls.set(d.toolUseId, call);
  if (!known) rehome(fold, d.toolUseId, owner, touched);
  if (d.denied) {
    call.denied = true;
    call.ms ??= d.ms;
    addRefusal(owner, d.toolUseId, 'cli-denied', d.display ?? d.target);
  } else {
    call.ms = d.ms;
    call.isError = d.isError;
    call.effectClass = d.effectClass;
    if (
      (d.effectClass === 'read' || d.effectClass === 'edit') &&
      d.target &&
      !owner.files.includes(d.target)
    )
      owner.files.push(d.target);
  }
  touched.push(owner.nodeId);
}

function addRefusal(n: NodeAcc, toolUseId: string, code: string, reason: string): void {
  if (n.refusals.some((r) => r.toolUseId === toolUseId && r.code === code)) return;
  n.refusals.push({ toolUseId, code, reason: reason.slice(0, 2000) });
}

/**
 * Отказ разрешения, ждавший начала своего вызова у сеанса (решение записано раньше
 * `tool.started`), — к узлу, которому вызов принадлежит (субагенту), один раз.
 */
function rehome(fold: AgentsFold, toolUseId: string, owner: NodeAcc, touched: string[]): void {
  const at = fold.strays.get(toolUseId);
  if (at === undefined) return;
  fold.strays.delete(toolUseId);
  const from = fold.nodes.get(at);
  if (!from || from === owner) return;
  for (let i = from.refusals.length - 1; i >= 0; i -= 1) {
    const r = from.refusals[i];
    if (r?.toolUseId !== toolUseId) continue;
    from.refusals.splice(i, 1);
    addRefusal(owner, r.toolUseId, r.code, r.reason);
  }
  touched.push(from.nodeId, owner.nodeId);
}

export function onDecision(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  const d = data(l, 'decision');
  const out = (d.output ?? {}) as Record<string, unknown>;
  if (d.class === 'observer' && typeof out.key === 'string') fold.decided.add(out.key);
  if (d.class === 'classify' && isClass(out.class)) fold.class = out.class;
  if (d.class === 'permit' && out.allow === false && l.sessionId) {
    const id = typeof out.toolUseId === 'string' && out.toolUseId ? out.toolUseId : null;
    const call = id ? fold.calls.get(id) : undefined;
    const owner = fold.nodes.get(call?.nodeId ?? l.sessionId);
    if (!owner || !id) return;
    // Вызова ещё нет — отказ лежит у сеанса временно: начало вызова перенесёт его к своему узлу.
    if (!call) fold.strays.set(id, owner.nodeId);
    addRefusal(
      owner,
      id,
      typeof out.code === 'string' ? out.code : 'permit-denied',
      d.reasons[0] ?? '',
    );
    touched.push(owner.nodeId);
  }
  if (d.class === 'tier' && l.stepId && out.ok === true) {
    const step = fold.steps.get(l.stepId);
    const key = step ? `${step.unitId}|${step.stepKind}` : l.stepId;
    const to = rung(out.model, out.effort);
    const sources = (out.sources ?? {}) as Record<string, unknown>;
    if (Object.values(sources).includes('escalation')) {
      const cause = typeof out.cause === 'string' ? out.cause : d.reasons.join('; ');
      const list = fold.escalations.get(l.stepId) ?? [];
      list.push({ from: fold.lastRung.get(key) ?? 'unknown', to, cause: cause.slice(0, 2000) });
      fold.escalations.set(l.stepId, list);
    }
    fold.lastRung.set(key, to);
  }
}

export function onSignal(fold: AgentsFold, l: JournalLine, touched: string[]): void {
  const s = data(l, 'signal');
  const n = fold.nodes.get(s.subject);
  if (!n || n.signals.includes(s.signal) || n.signals.length >= 50) return;
  n.signals.push(s.signal);
  touched.push(n.nodeId);
}
