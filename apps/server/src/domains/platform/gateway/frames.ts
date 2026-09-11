import { parseFrame, serializeFrame, splitFrames } from '../../dlp/sse.ts';
import { readViolations } from './status.ts';
import { errorBody, stopReasonOf, type Dialect } from './dialect.ts';

/**
 * Поток контура → поток клиента.
 *
 * Снаружи контур выглядит потоком OpenAI, но несёт в нём КАДРЫ БЕЗ `choices`
 * (справочник §7): стадия, размышление, отметка о чистке, срабатывание
 * проверок, финальный расход. Клиент, который делает `chunk.choices[0].delta`,
 * спотыкается на любом из них — а таких клиентов большинство.
 *
 * Поэтому шлюз разбирает поток сам (подпись `vendor-sse-frames`):
 *
 * - обычные чанки уходят клиенту (в его диалекте);
 * - вендорные кадры НЕ уходят никогда, но и не пропадают: стадии, сжатие
 *   истории и названия сработавших проверок попадают в след запроса, который
 *   видит человек в панели;
 * - `enterprise-platform_reasoning` отбрасывается: подделать подписанный блок размышлений
 *   диалекта Anthropic мост не может, а положить чужой текст в обычный ответ
 *   значило бы выдать размышление за ответ;
 * - `enterprise-platform_guardrails` со `stream_interrupted` превращается в ТЕРМИНАЛЬНУЮ
 *   ошибку клиента: молча оборвавшийся поток клиент считает удачным ответом;
 * - финальный расход снимается для учёта, а наружу уходит только если клиент
 *   сам его просил (`stream_options.include_usage`).
 */

/** Конец потока в диалекте OpenAI — его ждёт половина клиентов. */
const DONE_FRAME = 'data: [DONE]\n\n';

/** Причина, которую видит клиент, когда поток кончился на полуслове. */
export const TRUNCATED_MESSAGE =
  'Ответ контура оборвался: поток закончился без завершающего кадра — ответ неполон';

/** Вид кадра. Разделено ровно настолько, насколько разное с ними делают. */
export type FrameKind =
  /** Обычный чанк с содержимым. */
  | 'delta'
  /** Финальный чанк: `choices: []` и `usage`. */
  | 'usage'
  /** `enterprise-platform_status`: стадия. */
  | 'status'
  /** `enterprise-platform_reasoning`: размышления reasoning-модели. */
  | 'reasoning'
  /** `enterprise-platform_sanitized`: проверки что-то замаскировали на входе. */
  | 'sanitized'
  /** `enterprise-platform_guardrails`: вердикты, возможно с обрывом. */
  | 'guardrails'
  /** Кадры чата платформы, до API-клиента не относящиеся. */
  | 'anonymization'
  /** `[DONE]`. */
  | 'done'
  /** Кадр без `choices`, которого шлюз не знает. */
  | 'unknown';

/** Что панель узнала из потока. Ни текста ответа, ни текста нарушений тут нет. */
export interface FrameFacts {
  /** Стадии контура в порядке появления, без повторов. */
  stages: string[];
  /** Контур сжал историю сам (`context-managed`, справочник §5.1). */
  summarized: boolean;
  /** Названия сработавших проверок — только названия. */
  violations: string[];
  /**
   * Контур замаскировал часть данных и всё-таки ответил (`enterprise-platform_sanitized`).
   *
   * Отдельный факт, а не строка в `violations`: названий у этого кадра может не
   * быть вовсе, а знать о правке человеку нужно в любом случае — ответ пришёл
   * целым, и без пометки он считает, что модель видела его запрос.
   */
  masked: boolean;
  /** Поток оборван проверками. */
  interrupted: boolean;
  /**
   * Поток кончился, не досказав: ни `[DONE]`, ни причины остановки. Отличать
   * это от нормального конца обязательно — оборванный ответ, показанный как
   * законченный, и есть худший исход из возможных: человек читает половину
   * ответа как целый и не знает, что его обрезали.
   */
  truncated: boolean;
  /** Имена полей незнакомых кадров — чтобы новый вид кадра было видно. */
  unknownFrames: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Что собралось из потока для клиента, просившего НЕ поток. */
export interface AssembledAnswer {
  text: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  id: string;
}

export interface TranslatorOptions {
  /** На каком диалекте говорит КЛИЕНТ. Наверх всегда уходит OpenAI. */
  dialect: Dialect;
  /** Имя модели из запроса — для скелета ответа Anthropic. */
  model: string;
  /** Клиент сам просил расход в потоке. */
  includeUsage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Сколько названий и стадий помним на один запрос. Дальше — обрезка с пометкой. */
const MAX_VIOLATIONS = 16;
const MAX_STAGES = 8;

/** Вид кадра по его телу. Порядок проверок — от вендорного к обычному. */
export function classifyFrame(payload: unknown): FrameKind {
  if (!isRecord(payload)) return 'unknown';
  if (payload.enterprise-platform_status !== undefined) return 'status';
  if (payload.enterprise-platform_reasoning !== undefined) return 'reasoning';
  if (payload.enterprise-platform_sanitized !== undefined) return 'sanitized';
  if (payload.enterprise-platform_guardrails !== undefined) return 'guardrails';
  if (
    payload.enterprise-platform_deanonymized_entities !== undefined ||
    payload.enterprise-platform_anonymization_mapping !== undefined
  ) {
    return 'anonymization';
  }
  if (Array.isArray(payload.choices)) {
    return payload.choices.length === 0 && payload.usage !== undefined ? 'usage' : 'delta';
  }
  return 'unknown';
}

/**
 * Разборщик потока. Держит хвост незавершённого кадра, отдаёт клиенту готовые
 * байты и копит факты для панели.
 */
export class StreamTranslator {
  #options: TranslatorOptions;
  #buffer = '';
  #started = false;
  #finished = false;
  /**
   * Контур сказал, что ответ закончен: пришёл `[DONE]` или причина остановки в
   * чанке. Без этого признака конец потока неотличим от обрыва связи.
   */
  #complete = false;
  /** Клиенту уже отдана терминальная ошибка — дальше не пишем ничего. */
  #closed = false;
  #text = '';
  #finishReason = '';
  #id = '';
  #model = '';

  readonly facts: FrameFacts = {
    stages: [],
    summarized: false,
    violations: [],
    masked: false,
    interrupted: false,
    truncated: false,
    unknownFrames: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  constructor(options: TranslatorOptions) {
    this.#options = options;
    this.#model = options.model;
  }

  /** Кусок потока сверху → кусок потока клиенту. */
  // compromise: vendor-sse-frames — поток контура несёт кадры без choices, строгий клиент на них ломается
  push(chunk: string): string {
    this.#buffer += chunk;
    const { frames, rest } = splitFrames(this.#buffer);
    this.#buffer = rest;

    let out = '';
    for (const raw of frames) out += this.#frame(raw);
    return out;
  }

  /** Хвост и завершение диалекта. Вызывается один раз, после конца потока. */
  end(): string {
    let out = '';
    if (this.#buffer.trim()) {
      out += this.#frame(this.#buffer);
      this.#buffer = '';
    }
    if (this.#closed) return out;

    // Поток кончился, а контур не сказал ни `[DONE]`, ни причины остановки:
    // ingress закрыл простаивающее соединение, контур умер на полуслове, упёрся
    // в свой потолок. Дописать сюда «ответ завершён» значило бы выдать обрезок
    // за целое — клиент получает ОШИБКУ, как и при обрыве проверками.
    if (!this.#complete) {
      this.facts.truncated = true;
      return out + this.#terminal(TRUNCATED_MESSAGE, 'api_error');
    }

    if (this.#options.dialect === 'anthropic') {
      if (!this.#finished) out += this.#closeAnthropic();
      return out;
    }
    // Контур назвал причину остановки, но `[DONE]` не прислал: дописываем сами
    // — половина клиентов ждёт именно его, а ответ и правда закончен.
    if (!this.#finished) {
      this.#finished = true;
      out += DONE_FRAME;
    }
    return out;
  }

  /**
   * Прервать поток чужой бедой — обрывом связи с контуром, отказом транспорта.
   * Клиент обязан увидеть ошибку: молча закрытый поток он покажет как удачный
   * короткий ответ.
   */
  fail(message: string): string {
    if (this.#closed) return '';
    this.facts.truncated = true;
    return this.#terminal(message, 'api_error');
  }

  /** Ответ целиком — для клиента, который просил не поток. */
  assembled(): AssembledAnswer {
    return {
      text: this.#text,
      finishReason: this.#finishReason || 'stop',
      promptTokens: this.facts.promptTokens,
      completionTokens: this.facts.completionTokens,
      totalTokens: this.facts.totalTokens,
      model: this.#model,
      id: this.#id || `chatcmpl-${Date.now().toString(36)}`,
    };
  }

  #frame(raw: string): string {
    const parsed = parseFrame(raw);
    if (parsed.data.length === 0) return '';
    const data = parsed.data.join('\n').trim();
    if (!data) return '';

    if (data === '[DONE]') return this.#done();

    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      // Кадр, который не разбирается, наружу не идёт: строгий клиент на нём
      // сломается так же, как на вендорном, а «отдать как есть» здесь значит
      // отдать неизвестно что.
      this.#note('нечитаемый кадр');
      return '';
    }

    const kind = classifyFrame(payload);
    if (kind === 'delta') return this.#delta(payload as Record<string, unknown>);
    if (kind === 'usage') return this.#usage(payload as Record<string, unknown>, data);

    const frame = payload as Record<string, unknown>;
    const vendor = this.#vendor(kind, frame);
    // Кадр вправе нести И вердикт, И кусок ответа — в цельном теле они как раз
    // стоят рядом. Сняв факты, кусок надо отдать клиенту: проглоченный вместе с
    // вердиктом чанк уносил и текст, и `finish_reason`, после чего законченный
    // ответ приезжал человеку как оборванный.
    if (!vendor && Array.isArray(frame.choices)) {
      return frame.choices.length === 0 && frame.usage !== undefined
        ? this.#usage(frame, data)
        : this.#delta(frame);
    }
    return vendor;
  }

  /** Вендорный кадр: наружу не идёт никогда, в панель — фактом. */
  #vendor(kind: FrameKind, payload: Record<string, unknown>): string {
    if (kind === 'status') {
      const stage = String(payload.enterprise-platform_status ?? '');
      if (stage && !this.facts.stages.includes(stage) && this.facts.stages.length < MAX_STAGES) {
        this.facts.stages.push(stage);
      }
      // compromise: context-managed — сжатие истории видно только этим кадром, поэтому его снимаем в панель
      if (stage === 'summarizing') this.facts.summarized = true;
      return '';
    }
    if (kind === 'sanitized') {
      // Сам факт правки — отдельно от названий: контур вправе прислать кадр без
      // единого имени, и тогда «нарушений нет» означало бы «ничего не меняли».
      this.facts.masked = true;
      // Перечень лежит ВНУТРИ кадра, как и у гардрейлов. Читая снаружи, панель
      // не находила ни одного имени и молча показывала маскировку безымянной.
      const report = isRecord(payload.enterprise-platform_sanitized) ? payload.enterprise-platform_sanitized : payload;
      this.#addViolations(readViolations(report));
      return '';
    }
    if (kind === 'guardrails') {
      // Кадр читается на ОБОИХ уровнях, как и у маскировки. Живого 451 никто
      // ещё не видел, форма кадра — обещание документации, и строгое чтение
      // одного уровня давало худший исход из возможных: имена терялись, флаг
      // остановки терялся вместе с ними, а `[DONE]` следом закрывал поток —
      // человек получал оборванный ответ как законченный.
      const nested = payload.enterprise-platform_guardrails;
      const verdict = isRecord(nested) ? nested : payload;
      const before = this.facts.violations.length;
      this.#addViolations(readViolations(Array.isArray(nested) ? { violations: nested } : verdict));
      const interrupted =
        verdict.stream_interrupted === true || payload.stream_interrupted === true;
      // Кадр гардрейлов, из которого не вышло ни имени, ни вердикта, — это
      // форма, которой мост не знает. Молча выбросить её значило бы показать
      // «проверки молчали» там, где они что-то сказали.
      if (!interrupted && this.facts.violations.length === before) {
        this.#note(`enterprise-platform_guardrails: ${typeof nested}`);
      }
      if (interrupted) return this.#interrupt();
      return '';
    }
    // reasoning и кадры чата платформы: отбрасываем молча — они не про
    // API-клиента, и подделывать ими ответ мост не станет.
    if (kind === 'reasoning' || kind === 'anonymization') return '';

    this.#note(Object.keys(payload).slice(0, 4).join(', ') || 'кадр без полей');
    return '';
  }

  /** Обычный чанк: клиенту — в его диалекте, себе — текст для сборки. */
  #delta(payload: Record<string, unknown>): string {
    if (this.#closed) return '';
    if (typeof payload.id === 'string' && !this.#id) this.#id = payload.id;
    if (typeof payload.model === 'string') this.#model = payload.model;

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : {};
    const text = typeof delta.content === 'string' ? delta.content : '';
    if (text) this.#text += text;
    if (isRecord(choice) && typeof choice.finish_reason === 'string') {
      this.#finishReason = choice.finish_reason;
      // Причина остановки — второе (кроме `[DONE]`) слово контура о том, что
      // ответ закончен: часть шлюзов закрывает поток сразу после неё.
      this.#complete = true;
    }

    if (this.#options.dialect !== 'anthropic') {
      // Диалект тот же: кадр уходит как пришёл, байт в байт. Пересобирать его
      // значило бы терять поля, которых мост не знает, — и молча.
      return serializeFrame(undefined, JSON.stringify(payload));
    }

    let out = '';
    if (!this.#started) out += this.#openAnthropic();
    if (text) {
      out += serializeFrame(
        'content_block_delta',
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }),
      );
    }
    return out;
  }

  /** Финальный чанк с расходом: учёт — всегда, клиенту — только если просил. */
  #usage(payload: Record<string, unknown>, raw: string): string {
    const usage = isRecord(payload.usage) ? payload.usage : {};
    this.facts.promptTokens = numberOf(usage.prompt_tokens);
    this.facts.completionTokens = numberOf(usage.completion_tokens);
    this.facts.totalTokens =
      numberOf(usage.total_tokens) || this.facts.promptTokens + this.facts.completionTokens;

    if (this.#closed) return '';
    if (this.#options.dialect === 'anthropic') return '';
    return this.#options.includeUsage ? serializeFrame(undefined, raw) : '';
  }

  #done(): string {
    this.#complete = true;
    if (this.#closed) return '';
    this.#finished = true;
    if (this.#options.dialect === 'anthropic') return this.#closeAnthropic();
    return DONE_FRAME;
  }

  /**
   * Обрыв по проверкам. Клиент обязан увидеть ОШИБКУ: поток, кончившийся без
   * ответа, он покажет как пустой удачный ответ, и человек решит, что модель
   * промолчала, а не что запрос остановили.
   */
  #interrupt(): string {
    // compromise: status-451-bridge — обрыв проверок приходит кадром, клиенту он переводится терминальной ошибкой
    this.facts.interrupted = true;
    const names = this.facts.violations.join(', ');
    const message = names
      ? `Проверки контента контура остановили ответ: ${names}`
      : 'Проверки контента контура остановили ответ';
    return this.#terminal(message, 'content_policy_violation');
  }

  /**
   * Терминальная ошибка в диалекте клиента: после неё поток закрыт и ни один
   * кадр наружу больше не уходит. Форма — та, которую клиент разбирает своей
   * схемой: `event: error` у Anthropic, кадр с `error` и `[DONE]` у OpenAI.
   */
  #terminal(message: string, code: string): string {
    this.#closed = true;
    this.#finished = true;

    if (this.#options.dialect === 'anthropic') {
      return serializeFrame(
        'error',
        JSON.stringify(
          errorBody(
            'anthropic',
            message,
            code === 'api_error' ? 'api_error' : 'invalid_request_error',
          ),
        ),
      );
    }
    return (
      serializeFrame(undefined, JSON.stringify(errorBody('openai-compat', message, code))) +
      DONE_FRAME
    );
  }

  /** Начало сообщения в диалекте Anthropic — до первой дельты его нет. */
  #openAnthropic(): string {
    this.#started = true;
    const message = {
      id: `msg_${this.#id || Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model: this.#model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: this.facts.promptTokens, output_tokens: 0 },
    };
    return (
      serializeFrame('message_start', JSON.stringify({ type: 'message_start', message })) +
      serializeFrame(
        'content_block_start',
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      )
    );
  }

  /** Завершение сообщения. Вызывается и на `[DONE]`, и на обрыве соединения. */
  #closeAnthropic(): string {
    let out = '';
    if (!this.#started) out += this.#openAnthropic();
    this.#finished = true;
    out += serializeFrame(
      'content_block_stop',
      JSON.stringify({ type: 'content_block_stop', index: 0 }),
    );
    out += serializeFrame(
      'message_delta',
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReasonOf(this.#finishReason || 'stop'), stop_sequence: null },
        // Расход входа известен только к концу потока (кадр `usage` приходит
        // последним), а `message_start` ушёл на первой дельте с нулём. Anthropic
        // и сам отдаёт итоговый расход здесь — иначе строка таблицы
        // «usage.input_tokens ← usage.prompt_tokens» врала бы в потоке.
        usage: {
          input_tokens: this.facts.promptTokens,
          output_tokens: this.facts.completionTokens,
        },
      }),
    );
    out += serializeFrame('message_stop', JSON.stringify({ type: 'message_stop' }));
    return out;
  }

  /**
   * Названия — как и незнакомые кадры, ограничены по числу: контур волен
   * прислать их сколько угодно, а след одного запроса лежит в памяти и уезжает
   * в панель полсотней штук. Обрезка не молчаливая — что список неполон, видно
   * по `unknownFrames`.
   */
  #addViolations(names: string[]): void {
    for (const name of names) {
      if (this.facts.violations.length >= MAX_VIOLATIONS) {
        this.#note('перечень проверок обрезан');
        return;
      }
      if (!this.facts.violations.includes(name)) this.facts.violations.push(name);
    }
  }

  #note(name: string): void {
    if (this.facts.unknownFrames.length >= 8) return;
    if (!this.facts.unknownFrames.includes(name)) this.facts.unknownFrames.push(name);
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
