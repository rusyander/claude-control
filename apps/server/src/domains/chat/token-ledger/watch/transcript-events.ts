import { errorHeadOf, toolOutcome } from './tool-outcome.ts';
import type { WatchEvent } from './watch.types.ts';

/**
 * Строка транскрипта Claude → события сторожа. Нужна там, где потока нет:
 * транскрипты субагентов (`<сессия>/subagents/*.jsonl`) и вырезки настоящих
 * транскриптов в проверках правил. Ответ модели пишется строкой на каждый блок
 * содержимого с одним `message.id` — расход хода берётся один раз.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Сколько id ходов помнить для отсева повторов: ход растянут на соседние строки. */
const SEEN_CAP = 500;

function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    const text = obj(part)?.text;
    if (typeof text === 'string') chars += text.length;
  }
  return chars;
}

/**
 * Читатель транскрипта одной сессии. `sidechain` — весь файл чужой (субагент):
 * его вызовы идут в вес и «живость», но не в окно и не в повторы сессии.
 */
export function createTranscriptReader(options: { sidechain?: boolean } = {}) {
  const seen = new Set<string>();
  return (row: unknown): WatchEvent[] => {
    const record = obj(row);
    if (!record) return [];
    const t = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(t)) return [];
    const sidechain = options.sidechain === true || record.isSidechain === true;
    const flag = sidechain ? { sidechain: true as const } : {};

    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      if (sidechain) return [];
      // `/compact` по просьбе — не буря сжатий (R3).
      const manual = obj(record.compactMetadata)?.trigger === 'manual';
      return [{ kind: 'compact', t, ...(manual ? { manual: true } : {}) }];
    }

    // Запрос к модели сорвался, CLI повторяет (`request_retry`): сбой связи (R30). Лимит — R10.
    if (record.type === 'system' && record.subtype === 'api_error') {
      const error = obj(record.error);
      const status = error?.status;
      if (status === 429 || error?.rateLimits) return [];
      const formatted = typeof error?.formatted === 'string' ? error.formatted : '';
      const message = typeof error?.message === 'string' ? error.message : '';
      return [{ kind: 'apiError', t, head: errorHeadOf(formatted || message || 'api_error') }];
    }

    const attachment = obj(record.attachment);
    if (attachment) {
      const type = typeof attachment.type === 'string' ? attachment.type : 'attachment';
      return [{ kind: 'insert', t, type, chars: JSON.stringify(attachment).length }];
    }

    const message = obj(record.message);
    const content = message?.content;
    if (record.type === 'assistant' && message) {
      const out: WatchEvent[] = [];
      const id = typeof message.id === 'string' ? message.id : undefined;
      const usage = obj(message.usage);
      if (usage && !(id && seen.has(id))) {
        if (id) {
          seen.add(id);
          if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
        }
        const cacheCreation = obj(usage.cache_creation);
        out.push({
          kind: 'call',
          t,
          ...(typeof message.model === 'string' ? { model: message.model } : {}),
          input: num(usage.input_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite: num(usage.cache_creation_input_tokens),
          cacheWrite1h: num(cacheCreation?.ephemeral_1h_input_tokens),
          output: num(usage.output_tokens),
          ...flag,
        });
      }
      for (const block of Array.isArray(content) ? content : []) {
        const part = obj(block);
        // Текст самой сессии — хвост хода (R27, R33); блоки отделены пустой строкой, как абзацы.
        // Ответ об ошибке API пишет CLI, а не модель: не хвост.
        if (part?.type === 'text' && typeof part.text === 'string' && !sidechain) {
          if (record.isApiErrorMessage !== true)
            out.push({ kind: 'say', t, text: `${part.text}\n\n` });
          continue;
        }
        if (part?.type !== 'tool_use') continue;
        out.push({
          kind: 'tool',
          t,
          id: typeof part.id === 'string' ? part.id : '',
          name: typeof part.name === 'string' ? part.name : '',
          input: obj(part.input) ?? {},
          ...flag,
        });
      }
      return out;
    }

    if (record.type === 'user' && message) {
      const blocks = (Array.isArray(content) ? content : []).filter(
        (block) => obj(block)?.type === 'tool_result',
      );
      // Поля строки (`toolUseResult`, `toolDenialKind`) — об одном вызове: при нескольких не делятся.
      const extra =
        blocks.length === 1
          ? {
              timedOutAfterMs: obj(record.toolUseResult)?.timedOutAfterMs,
              denialKind: record.toolDenialKind,
            }
          : {};
      const results = blocks.flatMap((block): WatchEvent[] => {
        const part = obj(block);
        if (typeof part?.tool_use_id !== 'string') return [];
        const outcome = toolOutcome(part, extra);
        return [
          {
            kind: 'toolResult',
            t,
            id: part.tool_use_id,
            chars: textChars(part.content),
            ...outcome,
          },
        ];
      });
      if (results.length > 0) return results;
      // Реплика человека или панели начинает ход; служебные строки CLI — нет.
      if (sidechain || record.isMeta === true || record.isCompactSummary === true) return [];
      return textChars(content) > 0 ? [{ kind: 'start', t }] : [];
    }
    return [];
  };
}
