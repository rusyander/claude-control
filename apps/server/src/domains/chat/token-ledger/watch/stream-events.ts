import type { ChatEvent } from '../../chat-events.ts';
import { errorHeadOf } from './tool-outcome.ts';
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
          ...(event.remainder ? { sidechain: true, remainder: true } : {}),
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
      return [
        {
          kind: 'toolResult',
          t,
          id: event.toolUseId,
          chars: event.chars ?? 0,
          ...(event.timedOutMs ? { timedOutMs: event.timedOutMs } : {}),
          ...(event.denied ? { denied: event.denied } : {}),
          ...(event.isError ? { isError: true as const } : {}),
          ...(event.errorKind ? { errorKind: event.errorKind } : {}),
          ...(event.errorHead !== undefined ? { errorHead: event.errorHead } : {}),
        },
      ];
    case 'apiRetry':
      // Повтор запроса к модели — сбой связи (R30); исчерпанный лимит — это R10, не сюда.
      if (event.error === 'rate_limit' || event.status === 429) return [];
      return [{ kind: 'apiError', t, head: apiRetryHead(event) }];
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
    case 'text':
      // Длинный ответ без вызовов инструментов — не молчание; текст — хвост хода (R27, R33).
      return [
        { kind: 'activity', t },
        { kind: 'say', t, text: event.text },
      ];
    case 'thinking':
      // Длинный ответ без вызовов инструментов — не молчание: расход придёт концом сообщения.
      return [{ kind: 'activity', t }];
    case 'done':
      return [{ kind: 'end', t }];
    case 'error':
      // Прогон кончился сбоем: сетевой или серверный — ещё и сбой связи (R30).
      return isOutage(event.message)
        ? [
            { kind: 'apiError', t, head: errorHeadOf(event.message) },
            { kind: 'end', t },
          ]
        : [{ kind: 'end', t }];
    default:
      return [];
  }
}

/**
 * Сбой прогона похож на недоступный сервис: сеть, перегрузка, 5xx; лимит — R10. Ошибка
 * клиента (`API Error: 4xx` — вход, длина запроса) — не сбой связи, и число 5xx считается
 * только как код ответа, а не любое трёхзначное в тексте (F-104).
 */
function isOutage(message: string): boolean {
  if (/rate.?limit|\b429\b/i.test(message)) return false;
  if (/API Error:?\s*4\d\d\b/i.test(message)) return false;
  return /overloaded|server_error|No response from API|ECONN|ETIMEDOUT|fetch failed|socket hang up|Connection (?:lost|dropped|error)|(?:API Error|HTTP|status)[:\s]*5\d\d\b|API Error(?!:?\s*\d)/i.test(
    message,
  );
}

function apiRetryHead(event: Extract<ChatEvent, { kind: 'apiRetry' }>): string {
  return [event.error ?? 'api', event.status ? `HTTP ${event.status}` : '']
    .filter(Boolean)
    .join(' ');
}
