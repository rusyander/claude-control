import type { ChatEvent } from '../../chat-events.ts';
import type { WatchEvent } from './watch.types.ts';

/**
 * Событие живого потока прогона → события сторожа. Главная сессия файлов не
 * читает вовсе: расход хода, вызовы, размеры ответов, сжатия и лимит уже есть
 * в потоке (`ChatRunner.translate`, `stream-usage`).
 */
export function streamWatchEvents(event: ChatEvent, t: number, stage?: string): WatchEvent[] {
  switch (event.kind) {
    case 'usage':
      return [
        {
          kind: 'call',
          t,
          ...(event.model ? { model: event.model } : {}),
          input: event.input,
          cacheRead: event.cacheRead,
          cacheWrite: event.cacheCreation,
          cacheWrite1h: event.cacheCreation1h ?? 0,
          output: event.output,
          // Остаток сверки с итогом — субагенты и ходы без потока: вес есть, окна сессии нет.
          ...(event.remainder ? { sidechain: true } : {}),
        },
      ];
    case 'tool':
      return [
        {
          kind: 'tool',
          t,
          id: event.id,
          name: event.name,
          input:
            event.input && typeof event.input === 'object'
              ? (event.input as Record<string, unknown>)
              : {},
          ...(stage ? { stage } : {}),
          ...(event.parent ? { sidechain: true } : {}),
        },
      ];
    case 'toolResult':
      return [{ kind: 'toolResult', t, id: event.toolUseId, chars: event.chars ?? 0 }];
    case 'compact':
      // `/compact` по просьбе — не буря сжатий (R3).
      return [{ kind: 'compact', t, ...(event.trigger === 'manual' ? { manual: true } : {}) }];
    case 'limit': {
      // Замер окна и исчерпание — разные события: сброс у них может быть разный.
      const window = event.sample?.fiveHour;
      const out: WatchEvent[] = [];
      if (window) {
        out.push({ kind: 'limit', t, utilization: window.utilization, resetsAt: window.resetsAt });
      }
      if (event.status === 'rejected') {
        out.push({ kind: 'limit', t, rejected: true, resetsAt: event.resetsAt });
      }
      return out;
    }
    case 'done':
    case 'error':
      return [{ kind: 'end', t }];
    default:
      return [];
  }
}
