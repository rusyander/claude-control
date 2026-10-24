import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Что экран видел у прогона в прошлый раз. */
export interface SeenTurnEnd {
  key: string;
  at?: number;
  running: boolean;
}

/**
 * Конец хода, который экрану надо дочитать сам: отметка `endedAt` сменилась у
 * того же прогона, и это не переход «работает → закончил» — его ловит экран
 * разговора (там же переезд черновика на сессию и уход по `handoff`).
 */
export function turnEndUnseen(
  seen: SeenTurnEnd,
  key: string,
  at: number | undefined,
  running: boolean,
): boolean {
  if (seen.key !== key || at === undefined || at === seen.at) return false;
  return !(seen.running && !running);
}

/**
 * Перечитать транскрипт по отметке конца хода (`endedAt`). Не всякий конец
 * проходит через «работает»: ход, подхваченный опросом уже законченным,
 * идущим не бывает вовсе, а новый ход, в который привёл переподключённый поток,
 * сменяет прошлый без остановки. Ответ агента в обоих случаях уже в
 * транскрипте, а экран показывал его только после перезапуска приложения.
 */
export function useTurnEndRefresh(
  runKey: string,
  endedAt: number | undefined,
  running: boolean,
): void {
  const queryClient = useQueryClient();
  const seen = useRef<SeenTurnEnd>({ key: runKey, at: endedAt, running });
  useEffect(() => {
    const unseen = turnEndUnseen(seen.current, runKey, endedAt, running);
    seen.current = { key: runKey, at: endedAt, running };
    if (!unseen) return;
    void queryClient.invalidateQueries({ queryKey: ['chat'] });
    void queryClient.invalidateQueries({ queryKey: ['chats'] });
  }, [runKey, endedAt, running, queryClient]);
}
