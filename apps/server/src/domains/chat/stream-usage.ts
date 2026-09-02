import type { ChatEvent, RawEvent, RawUsage } from './chat-events.ts';

/**
 * Расход и границы блоков в потоке `stream-json` — то, что по одной строке не
 * разобрать, потому что правда размазана по нескольким.
 *
 * Замерено на claude 2.1.177 настоящим прогоном (запись
 * `.agent/tmp/stream-json-capture-2.1.177.jsonl`): событие `assistant` приходит
 * на КАЖДЫЙ блок содержимого — размышление, вызов, текст, — все с одним
 * `message.id`, и `usage` в них — заглушка из `message_start` (output_tokens
 * 2–4). Считать расход по ним значило удвоить-утроить вход и кэш и потерять
 * почти весь выход. Полный расход хода лежит ТОЛЬКО в
 * `stream_event/message_delta.usage`, модель хода — в `message_start`, итог
 * прогона — в `result.usage`.
 *
 * Поэтому здесь: один ход модели = один `usage`, собранный из `message_start`
 * (модель, часовая доля кэша) и `message_delta` (все счётчики), вместе с
 * вызовами, которые этот ход породил. В конце — сверка с `result`: всё, что
 * ходами не покрыто (субагенты, ходы без потоковых событий), уходит одним
 * остатком, чтобы итог прогона сошёлся с тем, что насчитал сам CLI.
 *
 * Без потоковых событий (старый CLI, `--include-partial-messages` не сработал)
 * расход берётся из `assistant` — но по одному разу на `message.id`.
 *
 * Заодно здесь границы блоков: текст двух соседних блоков склеивается в одну
 * строку, и без разделителя конец одного абзаца прилипал к началу другого.
 */

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
}

interface Turn {
  id: string;
  model?: string;
  /** Счётчики из `message_start` — подстраховка, если дельта пришла без них. */
  start: Tokens;
  toolIds: string[];
}

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 };

/** Счётчики записи; чего нет — берём из `base` (дельта не несёт разбивку кэша по сроку). */
function tokensOf(usage: RawUsage | undefined, base: Tokens = ZERO): Tokens {
  if (!usage) return base;
  return {
    input: usage.input_tokens ?? base.input,
    output: usage.output_tokens ?? base.output,
    cacheRead: usage.cache_read_input_tokens ?? base.cacheRead,
    cacheCreation: usage.cache_creation_input_tokens ?? base.cacheCreation,
    cacheCreation1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? base.cacheCreation1h,
  };
}

function usageEvent(
  tokens: Tokens,
  meta: { model?: string; toolIds?: string[]; remainder?: boolean },
): ChatEvent {
  return {
    kind: 'usage',
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheCreation: tokens.cacheCreation,
    cacheCreation1h: tokens.cacheCreation1h || undefined,
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.toolIds ? { toolIds: meta.toolIds } : {}),
    ...(meta.remainder ? { remainder: true } : {}),
  };
}

export class TurnTracker {
  private turn: Turn | undefined;
  /** Ходы, чей расход уже отдан, — по `message.id`. */
  private readonly seen = new Set<string>();
  private readonly total: Tokens = { ...ZERO };
  private textStarted = false;
  private thinkingStarted = false;
  /** Начался следующий блок — абзац отдадим, как только в нём появится текст. */
  private textPending = false;
  private thinkingPending = false;

  /** События интерфейса по одной строке потока: расход хода, разделители блоков, остаток. */
  track(raw: RawEvent): ChatEvent[] {
    if (raw.type === 'stream_event' && raw.event) return this.trackStream(raw.event);
    if (raw.type === 'assistant') return this.trackAssistant(raw);
    if (raw.type === 'result') return this.reconcile(raw);
    return [];
  }

  private trackStream(event: NonNullable<RawEvent['event']>): ChatEvent[] {
    if (event.type === 'message_start') {
      const message = event.message;
      this.turn = {
        id: message?.id ?? '',
        model: message?.model,
        start: tokensOf(message?.usage),
        toolIds: [],
      };
      return [];
    }

    // Разделитель ставим не на границе блока, а на первом его содержимом:
    // блок бывает и пустым, и тогда абзац разделял бы соседей впустую.
    if (event.type === 'content_block_start') {
      const type = event.content_block?.type;
      if (type === 'text' && this.textStarted) this.textPending = true;
      if (type === 'thinking' && this.thinkingStarted) this.thinkingPending = true;
      return [];
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this.textStarted = true;
        if (this.textPending) {
          this.textPending = false;
          return [{ kind: 'text', text: '\n\n' }];
        }
      }
      if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.thinkingStarted = true;
        if (this.thinkingPending) {
          this.thinkingPending = false;
          return [{ kind: 'thinking', text: '\n\n' }];
        }
      }
      return [];
    }

    if (event.type === 'message_delta') {
      const turn = this.turn;
      if (!turn) return [];
      this.turn = undefined;
      return [this.account(tokensOf(event.usage, turn.start), turn.id, turn.model, turn.toolIds)];
    }

    return [];
  }

  private trackAssistant(raw: RawEvent): ChatEvent[] {
    const message = raw.message;
    const id = message?.id;
    const toolIds = (message?.content ?? [])
      .filter((block) => block.type === 'tool_use' && block.id)
      .map((block) => block.id ?? '');

    // Открытый ход: вызовы копим, расход отдаст дельта.
    if (this.turn && (!id || id === this.turn.id)) {
      this.turn.toolIds.push(...toolIds);
      return [];
    }

    // Ход субагента: его расход панель не показывает отдельным шагом — вызова,
    // к которому его отнести, в этом разговоре нет, а в итог прогона он входит
    // и доедет остатком сверки. Считать его здесь значило бы записать чужой ход
    // в свой, да ещё по заглушке из `message_start`.
    if (raw.parent_tool_use_id) return [];

    // Потоковых событий нет — берём расход из самой записи, но один раз на ход.
    if (id && this.seen.has(id)) return [];
    if (!message?.usage) return [];
    return [this.account(tokensOf(message.usage), id, message.model, toolIds)];
  }

  private account(
    tokens: Tokens,
    id: string | undefined,
    model?: string,
    toolIds?: string[],
  ): ChatEvent {
    if (id) this.seen.add(id);
    this.total.input += tokens.input;
    this.total.output += tokens.output;
    this.total.cacheRead += tokens.cacheRead;
    this.total.cacheCreation += tokens.cacheCreation;
    this.total.cacheCreation1h += tokens.cacheCreation1h;
    return usageEvent(tokens, { model, toolIds });
  }

  /**
   * Сверка с итогом прогона. Остаток отдаём одним событием без вызовов: к
   * действию его не привязать, а размер окна по нему не судить — реестр это
   * знает по признаку `remainder`. Итог меньше насчитанного — молчим: отнимать
   * уже показанное нечем.
   */
  private reconcile(raw: RawEvent): ChatEvent[] {
    if (!raw.usage) return [];
    const final = tokensOf(raw.usage);
    const rest: Tokens = {
      input: Math.max(0, final.input - this.total.input),
      output: Math.max(0, final.output - this.total.output),
      cacheRead: Math.max(0, final.cacheRead - this.total.cacheRead),
      cacheCreation: Math.max(0, final.cacheCreation - this.total.cacheCreation),
      cacheCreation1h: Math.max(0, final.cacheCreation1h - this.total.cacheCreation1h),
    };
    if (
      rest.input + rest.output + rest.cacheRead + rest.cacheCreation + rest.cacheCreation1h ===
      0
    )
      return [];

    // Модель остатка известна, только когда в прогоне она была одна.
    const models = Object.keys(raw.modelUsage ?? {});
    const model = models.length === 1 ? models[0] : undefined;
    return [usageEvent(rest, { model, remainder: true })];
  }
}
