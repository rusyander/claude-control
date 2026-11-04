import type { ChatEvent, RawEvent } from '../chat-events.ts';
import { limitSampleOf } from '../limit-journal/limit-journal.ts';
import { resultText, toolOutcome } from '../token-ledger/watch/tool-outcome.ts';

/**
 * Строка `stream-json` CLI → события ленты — только для тестов реестра и маршрутов.
 * Разбор потока своего CLI жил в снятом исполнителе панели (`ChatRunner.translate`,
 * этап 10, G14); ход чата теперь ведёт ядро со своим переводом
 * (`core-run/translate.ts`). Тестам, которые кормят реестр строками CLI, нужен лишь
 * тот же итог для трёх видов строк: старт сессии, результат вызова, замер лимита.
 */
export function cliEvents(raw: RawEvent): ChatEvent[] {
  if (raw.type === 'system' && raw.subtype === 'init') {
    return [
      {
        kind: 'session',
        sessionId: raw.session_id ?? '',
        model: raw.model ?? '',
        tools: raw.tools?.length ?? 0,
      },
    ];
  }
  if (raw.type === 'user') {
    const content = raw.message?.content;
    const blocks = (Array.isArray(content) ? content : []).filter(
      (block) => block?.type === 'tool_result' && block.tool_use_id,
    );
    return blocks.map((block) => ({
      kind: 'toolResult',
      toolUseId: block.tool_use_id ?? '',
      chars: resultText(block.content).length,
      ...toolOutcome(block),
    }));
  }
  if (raw.type === 'rate_limit_event' && raw.rate_limit_info) {
    const sample = limitSampleOf(raw.rate_limit_info, Date.now());
    return [
      {
        kind: 'limit',
        resetsAt: raw.rate_limit_info.resetsAt ?? 0,
        type: raw.rate_limit_info.rateLimitType ?? '',
        status: raw.rate_limit_info.status ?? '',
        ...(sample ? { sample } : {}),
      },
    ];
  }
  throw new Error(`cliEvents: no test mapping for a "${raw.type}" line`);
}
