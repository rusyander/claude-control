import { useEffect, useRef } from 'react';
import type { PanelAgentEvent } from '@agentdeck/contracts/panel-agent';

type Listener = (event: PanelAgentEvent) => void;

const listeners = new Set<Listener>();

const AGENT_EVENT_TYPES = new Set(['agent-open-page', 'agent-pending', 'agent-decided']);

/**
 * Кадр агента ли это. Кадры агента идут по тому же `/api/events`, что и
 * `changed`, и разбирает поток один провайдер; всё, что не кадр агента, сюда
 * не пропускаем — окно не должно гадать над формой чужого кадра.
 */
export function isPanelAgentEvent(payload: unknown): payload is PanelAgentEvent {
  if (!payload || typeof payload !== 'object') return false;
  const type = (payload as { type?: unknown }).type;
  return typeof type === 'string' && AGENT_EVENT_TYPES.has(type);
}

/**
 * Передать кадр подписчикам. Зовёт его `FileWatchProvider`: второй
 * `EventSource` на тот же поток означал бы второе соединение и второй пропуск
 * кадров при обрыве — ровно то, от чего сервер кладёт кадры агента в общий поток.
 */
export function publishPanelAgentEvent(payload: unknown): boolean {
  if (!isPanelAgentEvent(payload)) return false;
  for (const listener of listeners) listener(payload);
  return true;
}

export function subscribePanelAgentEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Подписка компонента; обработчик держим в ref, чтобы не переподписываться на каждый рендер. */
export function usePanelAgentEvents(listener: Listener): void {
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribePanelAgentEvents((event) => ref.current(event)), []);
}
