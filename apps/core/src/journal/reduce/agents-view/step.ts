import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AgentsFold, NodeAcc } from '../agents-view.types.ts';
import { data, initAgentsFold } from './base.ts';
import { onCall, onDecision, onSignal, onUsage } from './calls.ts';
import { onAgent, onBg, onSession } from './lifecycle.ts';

/**
 * Одна строка в свёртку (по порядку `seq`; уже свёрнутая — пропущена). Ответ — узлы, чей вид
 * эта строка сдвинула (поток шлёт их кадрами `node`).
 */
export function stepAgents(fold: AgentsFold, l: JournalLine): string[] {
  if (l.seq <= fold.seq) return [];
  fold.seq = l.seq;
  const touched: string[] = [];
  switch (l.kind) {
    case 'task.created': {
      const d = data(l, 'task.created');
      fold.groupId = d.groupId ?? null;
      // Разговор задачи: запуск из чата, иначе продолжаемый разговор CLI (`resume`) — чат,
      // продолженный новой задачей, остаётся тем же разговором для «Агентов».
      fold.conversationId = d.launchOrigin?.conversationId ?? d.resume?.conversationId ?? null;
      if (fold.class === null && d.lead?.class) fold.class = d.lead.class;
      break;
    }
    case 'task.ended':
      fold.taskEnded = true;
      break;
    case 'step.started': {
      const d = data(l, 'step.started');
      fold.steps.set(d.stepId, { unitId: d.unitId, stepKind: d.stepKind });
      break;
    }
    case 'session.started':
    case 'session.transition':
      onSession(fold, l, touched);
      break;
    case 'turn.usage':
      onUsage(fold, l, touched);
      break;
    case 'tool.started':
    case 'tool.event':
      onCall(fold, l, touched);
      break;
    case 'agent.spawned':
    case 'agent.ended':
      onAgent(fold, l, touched);
      break;
    case 'bg.started':
    case 'bg.ended':
      onBg(fold, l, touched);
      break;
    case 'decision':
      onDecision(fold, l, touched);
      break;
    case 'signal':
      onSignal(fold, l, touched);
      break;
    default:
  }
  return [...new Set(touched.filter((id) => id !== ''))];
}

export function foldAgents(taskId: string, lines: Iterable<JournalLine>): AgentsFold {
  const fold = initAgentsFold(taskId);
  for (const l of lines) stepAgents(fold, l);
  return fold;
}

/** Открытые фоновые работы задачи (нет `bg.ended`) — то, за чем следит сторож фона. */
export function openBgItems(fold: AgentsFold): NodeAcc[] {
  return [...fold.nodes.values()].filter((n) => n.bg !== null && n.bg.how === undefined);
}
