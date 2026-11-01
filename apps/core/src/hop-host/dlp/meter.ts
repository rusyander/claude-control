import type { DlpApiKind } from '@agentdeck/dlp/api-shapes';
import { AnthropicStreamMeter, messageFacts } from '../gateway/anthropic-native.ts';
import { cacheTokensOf } from '../gateway/dialect/cache-usage.ts';
import type { SpendUsage } from '../spend.types.ts';

/**
 * Расход ответа на звене без перевода (P122 «spend per session tag»): поток читается сбоку,
 * байты клиенту идут как пришли. Anthropic — счётчик родной ручки шлюза; OpenAI — последний
 * кадр с `usage` (его просит `stream_options.include_usage`, звено не дописывает это в тело:
 * тело — клиента, и звено без перевода его не правит).
 */

export interface UsageMeter {
  push(text: string): void;
  end(): void;
  usage(): SpendUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * OpenAI: вход включает прочитанное из кэша и (у LiteLLM) записанное в кэш, поэтому вход без
 * кэша — разность; запись идёт своей ставкой (`cache-usage.ts` — те же поля, что у шлюза).
 */
function openAiUsage(usage: unknown): SpendUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const prompt = num(usage.prompt_tokens);
  const cache = cacheTokensOf(usage);
  const read = Math.min(cache.read, prompt);
  const write = Math.min(cache.write, prompt - read);
  return {
    input: prompt - read - write,
    cacheRead: read,
    cacheWrite: write,
    cacheWrite1h: Math.min(cache.write1h, write),
    output: num(usage.completion_tokens),
  };
}

function anthropicUsage(facts: ReturnType<typeof messageFacts>): SpendUsage {
  return {
    input: Math.max(facts.promptTokens - facts.cachedTokens - facts.cacheWriteTokens, 0),
    cacheRead: facts.cachedTokens,
    cacheWrite: facts.cacheWriteTokens,
    cacheWrite1h: facts.cacheWrite1hTokens,
    output: facts.completionTokens,
  };
}

const ZERO: SpendUsage = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };

class OpenAiStreamMeter implements UsageMeter {
  #buffer = '';
  #usage: SpendUsage = ZERO;

  push(text: string): void {
    this.#buffer += text;
    const frames = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = frames.pop() ?? '';
    for (const frame of frames) this.#frame(frame);
  }

  end(): void {
    if (this.#buffer.trim()) this.#frame(this.#buffer);
    this.#buffer = '';
  }

  usage(): SpendUsage {
    return this.#usage;
  }

  #frame(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data) as unknown;
      const usage = isRecord(payload) ? openAiUsage(payload.usage) : undefined;
      if (usage) this.#usage = usage;
    } catch {
      // Не JSON — не наш кадр расхода; поток при этом идёт клиенту как есть.
    }
  }
}

export function streamMeter(kind: DlpApiKind): UsageMeter {
  if (kind === 'openai-compat') return new OpenAiStreamMeter();
  const meter = new AnthropicStreamMeter();
  return {
    push: (text) => meter.push(text),
    end: () => meter.end(),
    usage: () => anthropicUsage(meter.facts),
  };
}

/** Расход цельного ответа. */
export function jsonUsage(kind: DlpApiKind, payload: unknown): SpendUsage {
  if (kind === 'anthropic') return anthropicUsage(messageFacts(payload));
  return (isRecord(payload) ? openAiUsage(payload.usage) : undefined) ?? ZERO;
}
