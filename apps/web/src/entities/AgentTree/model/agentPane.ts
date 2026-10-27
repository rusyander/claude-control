import { useSyncExternalStore } from 'react';
import type { AgentPaneTarget } from './agentTree.types';

/**
 * Какой ход субагента открыт справа. Общий на панель, а не состояние чата:
 * открывают его и дерево в «Плане агента», и переход из карточки группы в
 * хабе родителя — тот сначала уводит в чат группы, и панель должна встретить
 * человека уже открытой.
 */
let target: AgentPaneTarget | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AgentPaneTarget | undefined {
  return target;
}

export function openAgentPane(chatId: string, agentId: string): void {
  if (target?.chatId === chatId && target.agentId === agentId) return;
  target = { chatId, agentId };
  emit();
}

/**
 * Закрыть панель и вернуть фокус узлу, с которого её открыли: человек с
 * клавиатуры продолжает ходить по дереву с того же места. `false` — столбец
 * отдают другому содержимому (артефакту), и фокус остаётся, где был.
 */
export function closeAgentPane(returnFocus = true): void {
  const closed = target;
  if (!closed) return;
  target = undefined;
  emit();
  if (!returnFocus || typeof document === 'undefined') return;
  const node = document.querySelector<HTMLElement>(
    `[data-agent-node="${CSS.escape(closed.agentId)}"]`,
  );
  node?.focus();
}

export function getAgentPane(): AgentPaneTarget | undefined {
  return target;
}

/** Открытый ход субагента — только если он этого разговора. */
export function useAgentPane(chatId: string | undefined): AgentPaneTarget | undefined {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return current && chatId && current.chatId === chatId ? current : undefined;
}
