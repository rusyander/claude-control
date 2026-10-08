import { useEffect, useRef } from 'react';
import type { Listener } from './events.types';
import { subscribePanelAgentEvents } from '../lib/subscribePanelAgentEvents';

/** Подписка компонента; обработчик держим в ref, чтобы не переподписываться на каждый рендер. */
export function usePanelAgentEvents(listener: Listener): void {
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribePanelAgentEvents((event) => ref.current(event)), []);
}
