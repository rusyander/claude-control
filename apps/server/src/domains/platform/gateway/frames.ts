import { parseFrame, serializeFrame, splitFrames } from '../../dlp/sse.ts';
import type { VendorFrame, VendorFrameKind } from '../drivers/driver.ts';
import { readViolations } from './status.ts';
import { errorBody, stopReasonOf, type Dialect } from './dialect.ts';
import { expandContourAliases, strayAliases } from './tool-shim/aliases.ts';
import { claimedWithoutCall } from './tool-shim/claims.ts';
import type { ShimCall } from './tool-shim/parse.ts';
import { ToolStreamParser, type ShimEvent } from './tool-shim/stream.ts';

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

/**
 * Вид кадра. Разделено ровно настолько, насколько разное с ними делают.
 *
 * Вендорная половина (стадия, размышление, отметка о чистке, вердикты,
 * подмена) приходит из драйвера: шлюз знает, ЧТО делать с каждым видом, и не
 * знает, по какому полю его узнать, — иначе вторая платформа потребовала бы
 * править разборщик потока.
 */
export type FrameKind =
  | VendorFrameKind
  /** Обычный чанк с содержимым. */
  | 'delta'
  /** Финальный чанк: `choices: []` и `usage`. */
  | 'usage'
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
  /**
   * Контур подтвердил кадром, что инструменты клиента до модели не дошли.
   *
   * Свой факт, а не строка в `unknownFrames`: там живёт «панель такого кадра не
   * знает», а этот она знает — и он объясняет человеку, почему агент ничего не
   * сделал руками.
   */
  toolsDropped: boolean;
  /**
   * Части ответа, которые мост не перенёс клиенту (картинка контура и всё, что
   * не текст). Пусто — терять было нечего; строка здесь означает, что человеку
   * надо сказать, ЧТО именно пропало, а не показать пустой ответ.
   */
  droppedParts: string[];
  /** Вызовов инструментов, собранных прослойкой из текста ответа (Т5.5). */
  toolCalls: number;
  /** Блоки, которые вызовом не стали, — по причине на блок, без повторов. */
  toolFlaws: string[];
  /**
   * Метки защиты данных, которые доехали до аргументов вызова и не
   * развернулись (Р11, Т5.7). Непусто — ход остановлен НАМИ, а не контуром:
   * выполненный вызов записал бы метку в файл вместо значения.
   */
  maskStop: string[];
  /**
   * Модель описала действие словами и не вызвала ничего (эвристика, Т5.5).
   * Только пометка: ход не блокируется, но человек видит, почему файла нет.
   */
  claimedWithoutCall: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Что собралось из потока для клиента, просившего НЕ поток. */
export interface AssembledAnswer {
  text: string;
  /** Вызовы, собранные прослойкой: клиенту они уедут полем его диалекта. */
  calls: ShimCall[];
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
  /**
   * Чей это поток. Обязателен: «поток ничей» — это молчаливое обещание, что
   * вендорных кадров не будет, а поток, в котором они всё-таки есть, читается
   * тогда как обычный OpenAI и теряет вердикты целиком.
   */
  driver: FrameDriver;
  /**
   * Прослойка инструментов включена (Т5): текст ответа разбирается на вызовы, и
   * клиент получает их полем СВОЕГО диалекта. Нет ключа — прослойки нет, и
   * поток идёт ровно так, как шёл до неё.
   */
  shim?: {
    allowed: ReadonlySet<string>;
    /**
     * Метки, выданные защитой данных этому запросу (`AliasVault.reverse()`).
     * Разворачивает их граница шлюза, а прослойке они нужны, чтобы отличить
     * СВОЮ метку в аргументе вызова от чужого текста в квадратных скобках
     * (Р11, Т5.7). Нет словаря — нет и остановок.
     */
    aliases?: ReadonlyMap<string, string>;
    /**
     * В истории запроса УЖЕ есть вызов или его результат — то есть ход агента
     * идёт и инструменты в нём работают.
     *
     * Нужно ровно для пометки «описала действие и не вызвала ничего». Последний
     * запрос любого удачного хода — это итоговая реплика («файл создан»), и
     * вызовов в ней, разумеется, нет: без этого признака пометка загоралась бы
     * почти на каждом УСПЕШНОМ прогоне и обесценилась бы за день.
     */
    priorCalls?: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Сколько названий и стадий помним на один запрос. Дальше — обрезка с пометкой. */
const MAX_VIOLATIONS = 16;
const MAX_STAGES = 8;
/**
 * Потолок карты подмены контура на один ответ. Карта приходит кадрами чужой
 * стороны, то есть её размер выбираем не мы; без потолка один ответ мог бы
 * занять память панели целиком.
 */
const MAX_CONTOUR_ALIASES = 2_000;

/** Защита данных выключена: словаря меток нет, и остановить ход нечему. */
const EMPTY_ALIASES: ReadonlyMap<string, string> = new Map();

/**
 * Текст остановки — один на оба пути, поток и цельное тело. Написанный дважды,
 * он разошёлся бы, и человек читал бы разные объяснения одной беды.
 */
export function maskStopMessage(names: string): string {
  return `Вызов инструмента остановлен: метку защиты данных ${names} нечем развернуть — она уехала бы в файл вместо значения`;
}

/**
 * Вид кадра по его телу. Порядок проверок — от вендорного к обычному.
 *
 * Вендорный кадр узнаёт ДРАЙВЕР, и его ответ идёт первым: кадр платформы
 * бывает и с полем `choices` рядом, а принять его за обычный чанк значит
 * отдать клиенту служебное тело. Драйвера нет — остаётся общая часть, то есть
 * поток читается как обычный OpenAI.
 */
export function classifyFrame(payload: unknown, driver: FrameDriver): FrameKind {
  if (!isRecord(payload)) return 'unknown';
  const vendor = driver.readFrame(payload);
  if (vendor) return vendor.kind;
  if (Array.isArray(payload.choices)) {
    return payload.choices.length === 0 && payload.usage !== undefined ? 'usage' : 'delta';
  }
  return 'unknown';
}

/**
 * Что разборщику потока нужно от драйвера. Узкий кусок манифеста, а не весь
 * драйвер: шлюзу незачем знать ни про адреса, ни про матрицу возможностей.
 *
 * Обязателен, а не необязателен. Умолчание «драйвера нет» отвечало на всё
 * успокаивающе — «вендорных кадров не бывает», — и забытый аргумент на новом
 * маршруте означал бы, что оборвавший ответ вердикт прочитан как незнакомый
 * кадр. Контур без своих кадров подставляет драйвер, который так и говорит
 * (`openai-compat`), а не пустое место.
 */
export interface FrameDriver {
  readFrame(payload: Record<string, unknown>): VendorFrame | undefined;
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
  /** Разбор вызовов из текста ответа. Есть только при включённой прослойке. */
  #parser: ToolStreamParser | undefined;
  #calls: ShimCall[] = [];
  /**
   * Карта подмены контура, собранная из вендорных кадров (Р11). Копится по ходу
   * потока: кадр с картой вправе приехать и раньше вызова, и позже.
   */
  readonly #contourAliases = new Map<string, string>();
  /** Хвост разбора уже отдан: второй раз он отдал бы только лишнюю пометку. */
  #flushed = false;
  /** Номер текущего блока содержимого в диалекте Anthropic. */
  #index = 0;
  #textOpen = false;

  readonly facts: FrameFacts = {
    stages: [],
    summarized: false,
    violations: [],
    masked: false,
    interrupted: false,
    truncated: false,
    unknownFrames: [],
    toolsDropped: false,
    droppedParts: [],
    toolCalls: 0,
    toolFlaws: [],
    maskStop: [],
    claimedWithoutCall: false,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  constructor(options: TranslatorOptions) {
    this.#options = options;
    this.#model = options.model;
    if (options.shim) this.#parser = new ToolStreamParser({ allowed: options.shim.allowed });
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
      // Придержанное отдаётся текстом ДО ошибки: без прослойки клиент получил
      // бы прочитанную половину ответа, и терять её из-за того, что разборщик
      // держал блок, — регресс, который платит человек.
      return out + this.#abortShim() + this.#terminal(TRUNCATED_MESSAGE, 'api_error');
    }

    if (this.#options.dialect === 'anthropic') {
      if (!this.#finished) out += this.#closeAnthropic();
      return out;
    }
    // Придержанный хвост — раньше `[DONE]`: после него клиент читать перестаёт.
    out += this.#flushShim();
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
    return this.#abortShim() + this.#terminal(message, 'api_error');
  }

  /** Ответ целиком — для клиента, который просил не поток. */
  assembled(): AssembledAnswer {
    return {
      text: this.#text,
      calls: this.#calls,
      // Вызов перебивает причину остановки и здесь: клиент, прочитавший
      // «ход закончен» рядом с вызовом, выполнит его и не пришлёт результат.
      finishReason: this.#calls.length > 0 ? 'tool_calls' : this.#finishReason || 'stop',
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

    const driver = this.#options.driver;
    const vendorFrame = isRecord(payload) ? driver.readFrame(payload) : undefined;
    if (!vendorFrame) {
      const kind = classifyFrame(payload, driver);
      if (kind === 'delta') return this.#delta(payload as Record<string, unknown>);
      if (kind === 'usage') return this.#usage(payload as Record<string, unknown>, data);
      this.#note(
        Object.keys(payload as object)
          .slice(0, 4)
          .join(', ') || 'кадр без полей',
      );
      return '';
    }

    const frame = payload as Record<string, unknown>;
    const vendor = this.#vendor(vendorFrame);
    // Кадр вправе нести И вердикт, И кусок ответа — в цельном теле они как раз
    // стоят рядом. Сняв факты, кусок надо отдать клиенту: проглоченный вместе с
    // вердиктом чанк уносил и текст, и `finish_reason`, после чего законченный
    // ответ приезжал человеку как оборванный. Но уходит он БЕЗ вендорных полей:
    // отдать их клиенту — то же самое, что отдать вендорный кадр целиком, от
    // чего весь этот разборщик и заведён.
    if (!vendor && Array.isArray(frame.choices)) {
      const clean = this.#stripVendor(frame);
      return frame.choices.length === 0 && frame.usage !== undefined
        ? this.#usage(clean, JSON.stringify(clean))
        : this.#delta(clean);
    }
    return vendor;
  }

  /**
   * Копия кадра без вендорных полей. Какие поля вендорные, отвечает драйвер — и
   * отвечает по одному: кадр вправе нести сразу два вердикта, а знать их имена
   * шлюзу по-прежнему нечем.
   */
  #stripVendor(frame: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frame)) {
      if (this.#options.driver.readFrame({ [key]: value })) continue;
      clean[key] = value;
    }
    return clean;
  }

  /** Вендорный кадр: наружу не идёт никогда, в панель — фактом. */
  #vendor(frame: VendorFrame): string {
    if (frame.kind === 'status') {
      const stage = frame.stage ?? '';
      if (stage && !this.facts.stages.includes(stage) && this.facts.stages.length < MAX_STAGES) {
        this.facts.stages.push(stage);
      }
      // compromise: context-managed — сжатие истории видно только этим кадром, поэтому его снимаем в панель
      if (stage === 'summarizing') this.facts.summarized = true;
      return '';
    }
    if (frame.kind === 'sanitized') {
      // Сам факт правки — отдельно от названий: контур вправе прислать кадр без
      // единого имени, и тогда «нарушений нет» означало бы «ничего не меняли».
      this.facts.masked = true;
      this.#addViolations(readViolations(frame.verdict));
      return '';
    }
    if (frame.kind === 'guardrails') {
      const before = this.facts.violations.length;
      this.#addViolations(readViolations(frame.verdict));
      // Кадр гардрейлов, из которого не вышло ни имени, ни вердикта, — это
      // форма, которой мост не знает. Молча выбросить её значило бы показать
      // «проверки молчали» там, где они что-то сказали.
      if (!frame.interrupted && this.facts.violations.length === before) {
        this.#note(`${frame.field}: вердикт без имён`);
      }
      if (frame.interrupted) return this.#interrupt();
      return '';
    }
    if (frame.kind === 'tools-dropped') {
      // Наружу кадр не идёт (строгий клиент на нём сломается), но факт остаётся:
      // конвейер допишет `tools` в список потерянного, и человек увидит причину
      // бездействия агента там же, где остальные потери перевода.
      this.facts.toolsDropped = true;
      return '';
    }
    if (frame.kind === 'anonymization') {
      // Кадр наружу не идёт (клиент его схемой не разбирает), но карта из него
      // нужна прослойке: метка, доехавшая до аргумента `Write`, уедет в файл.
      // Сам факт правки — тот же, что у `sanitized`: человеку важно знать, что
      // модель видела не то, что он написал.
      for (const [alias, value] of Object.entries(frame.mapping ?? {})) {
        if (this.#contourAliases.size >= MAX_CONTOUR_ALIASES) break;
        this.#contourAliases.set(alias, value);
        this.facts.masked = true;
      }
      return '';
    }
    // reasoning и кадры чата платформы: отбрасываем молча — они не про
    // API-клиента, и подделывать ими ответ мост не станет.
    return '';
  }

  /** Обычный чанк: клиенту — в его диалекте, себе — текст для сборки. */
  #delta(payload: Record<string, unknown>): string {
    if (this.#closed) return '';
    if (typeof payload.id === 'string' && !this.#id) this.#id = payload.id;
    if (typeof payload.model === 'string') this.#model = payload.model;

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : {};
    const text = this.#contentText(delta.content);
    const finishReason =
      isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
    if (finishReason) {
      this.#finishReason = finishReason;
      // Причина остановки — второе (кроме `[DONE]`) слово контура о том, что
      // ответ закончен: часть шлюзов закрывает поток сразу после неё.
      this.#complete = true;
    }

    // Прослойка включена: текст сначала проходит разбор — вызов, уехавший
    // клиенту текстом, агент показывает человеку вместо того, чтобы выполнить.
    if (this.#parser) return this.#shimDelta(payload, this.#parser.push(text), finishReason);

    if (text) this.#text += text;
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

  /**
   * Кусок ответа при включённой прослойке.
   *
   * Здесь кадр диалекта OpenAI ПЕРЕСОБИРАЕТСЯ, а не уходит байт в байт: мы
   * только что вынули из его текста вызов и обязаны отдать его полем
   * `tool_calls`. Отдать и текст вызова, и вызов — значит показать человеку в
   * ответе служебный блок; отдать кадр как есть — значит не отдать вызов вовсе.
   */
  #shimDelta(
    payload: Record<string, unknown>,
    events: readonly ShimEvent[],
    finishReason: string,
  ): string {
    let out = '';
    for (const event of events) {
      if (event.type === 'text') {
        this.#text += event.text;
        out += this.#renderText(event.text, payload);
        continue;
      }
      const prepared = this.#prepareCall(event.call);
      if ('stray' in prepared) return out + this.#maskStop(prepared.stray);
      this.#calls.push(prepared.call);
      this.#noteCalls();
      out += this.#renderCall(prepared.call, payload);
    }

    if (!finishReason) return out;
    // Причина остановки — слово контура о том, что ответ кончился; всё, что
    // разборщик ещё держит, надо отдать ДО неё, иначе хвост ответа уедет
    // клиенту после конца хода и будет им выброшен.
    out += this.#flushShim();
    if (this.#options.dialect === 'anthropic') return out;
    // Саму причину нельзя ни потерять, ни оставить прежней: клиент, получивший
    // вызов при `finish_reason: "stop"`, выполняет его и на этом заканчивает
    // ход — ровно так, как если бы вызова не было.
    return out + this.#openAiFrame(payload, {}, this.#openAiFinish(finishReason));
  }

  /** Текст ответа — в диалекте клиента. */
  #renderText(text: string, payload: Record<string, unknown>): string {
    if (!text) return '';
    if (this.#options.dialect !== 'anthropic') {
      return this.#openAiFrame(payload, { content: text }, null);
    }
    let out = '';
    if (!this.#started) out += this.#openAnthropic();
    if (!this.#textOpen) out += this.#startText();
    return (
      out +
      serializeFrame(
        'content_block_delta',
        JSON.stringify({
          type: 'content_block_delta',
          index: this.#index,
          delta: { type: 'text_delta', text },
        }),
      )
    );
  }

  /** Собранный вызов — блоком `tool_use` либо полем `tool_calls`. */
  #renderCall(call: ShimCall, payload: Record<string, unknown>): string {
    if (this.#options.dialect !== 'anthropic') {
      return this.#openAiFrame(
        payload,
        {
          tool_calls: [
            {
              index: this.#calls.length - 1,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        },
        null,
      );
    }

    let out = '';
    if (!this.#started) out += this.#openAnthropic();
    if (this.#textOpen) out += this.#stopBlock();
    out += serializeFrame(
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: this.#index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      }),
    );
    // Аргументы уходят ОДНОЙ дельтой: собирать их по кускам незачем — к этому
    // времени вызов уже разобран целиком, а клиент склеивает `partial_json` сам.
    out += serializeFrame(
      'content_block_delta',
      JSON.stringify({
        type: 'content_block_delta',
        index: this.#index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) },
      }),
    );
    return out + this.#stopBlock();
  }

  /** Кадр диалекта OpenAI с нашей начинкой; скелет берётся у кадра контура. */
  #openAiFrame(
    payload: Record<string, unknown>,
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): string {
    const frame = {
      id: typeof payload.id === 'string' ? payload.id : this.#id,
      object: 'chat.completion.chunk',
      ...(typeof payload.created === 'number' ? { created: payload.created } : {}),
      model: typeof payload.model === 'string' ? payload.model : this.#model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return serializeFrame(undefined, JSON.stringify(frame));
  }

  /** Причина остановки для клиента: вызов был — значит ход не закончен. */
  #openAiFinish(finishReason: string): string {
    return this.#calls.length > 0 ? 'tool_calls' : finishReason;
  }

  /**
   * Хвост разбора: придержанный текст и незакрытый блок. Зовётся ровно один раз
   * на конце ответа — повторный вызов отдал бы пустоту, но пометка «блок без
   * закрывающего тега» встала бы дважды.
   */
  #flushShim(): string {
    const parser = this.#parser;
    if (!parser || this.#flushed) return '';
    this.#flushed = true;

    let out = '';
    for (const event of parser.end()) {
      if (event.type === 'text') {
        this.#text += event.text;
        out += this.#renderText(event.text, {});
        continue;
      }
      const prepared = this.#prepareCall(event.call);
      if ('stray' in prepared) return out + this.#maskStop(prepared.stray);
      this.#calls.push(prepared.call);
      out += this.#renderCall(prepared.call, {});
    }
    this.#noteCalls();
    // compromise: tool-shim — модель вправе описать действие словами вместо вызова; панель это только помечает
    // Ход, в котором вызовы уже были, пометкой не красится: «файл создан» в
    // итоговой реплике после состоявшегося вызова — правда, а не заявка.
    this.facts.claimedWithoutCall =
      this.#options.shim?.priorCalls !== true && claimedWithoutCall(this.#text, this.#calls.length);
    return out;
  }

  /**
   * Обрыв: всё придержанное отдаётся ТЕКСТОМ, вызовов не синтезируется.
   *
   * Разница с `#flushShim` принципиальная. Там ответ кончился — блок, дошедший
   * целиком, законно становится вызовом. Здесь ответ оборвали (контур умер,
   * ingress закрыл соединение), и клиент в тот же миг получит терминальную
   * ошибку: вызов рядом с ней — это действие над файлами человека, собранное из
   * потока, который панель сама объявила негодным. А вот текст терять нельзя:
   * без прослойки человек увидел бы прочитанную половину ответа.
   */
  #abortShim(): string {
    const parser = this.#parser;
    if (!parser || this.#flushed) return '';
    this.#flushed = true;

    const text = parser.abort();
    if (!text) return '';
    this.#text += text;
    return this.#renderText(text, {});
  }

  /**
   * Вызов перед синтезом: карта подмены контура развёрнута, наши метки
   * проверены (Р11, Т5.7). Обе половины — до синтеза блока, а не после: после
   * него вызов уже у клиента, и остановить нечего.
   */
  #prepareCall(call: ShimCall): { call: ShimCall } | { stray: string[] } {
    const args = expandContourAliases(call.arguments, this.#contourAliases);
    const stray = strayAliases(args, this.#options.shim?.aliases ?? EMPTY_ALIASES);
    if (stray.length > 0) return { stray };
    return { call: { ...call, arguments: args } };
  }

  /**
   * Метку нечем развернуть — ход останавливается терминальной ошибкой.
   *
   * Это единственное место, где прослойка что-то ЗАПРЕЩАЕТ, и запрет здесь
   * дешевле пропуска: вызов с меткой вместо значения выполнится молча и оставит
   * её в файле, где человек найдёт её не сегодня.
   */
  #maskStop(stray: string[]): string {
    // compromise: tool-shim — вызов синтезируется из текста, и метка в аргументе останавливает ход
    this.facts.maskStop = stray;
    this.facts.interrupted = true;
    const names = stray.join(', ');
    const reason = `mask-unrestorable: ${names}`;
    if (!this.facts.toolFlaws.includes(reason)) this.facts.toolFlaws.push(reason);
    return this.#terminal(maskStopMessage(names), 'content_policy_violation');
  }

  /** Причина остановки в диалекте Anthropic: вызов перебивает любую другую. */
  #stopReason(): string {
    return this.#calls.length > 0 ? 'tool_use' : stopReasonOf(this.#finishReason || 'stop');
  }

  #noteCalls(): void {
    this.facts.toolCalls = this.#calls.length;
    for (const flaw of this.#parser?.flaws ?? []) {
      const reason = flaw.name ? `${flaw.reason}: ${flaw.name}` : flaw.reason;
      if (!this.facts.toolFlaws.includes(reason)) this.facts.toolFlaws.push(reason);
    }
  }

  /**
   * Текст содержимого — строкой либо частями. Часть, которая не текст (картинка
   * контура приезжает именно так), в диалект Anthropic мостом не переносится, и
   * вот это называется вслух: молча обнулённая картинка — ответ, в котором
   * человек видит пустоту и не знает, что она была.
   */
  #contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    let text = '';
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') {
        text += part.text;
        continue;
      }
      // Потеря считается только там, где она есть. В своём диалекте кадр уходит
      // клиенту байт в байт вместе с этой частью — записать её в потерянное
      // значило бы соврать человеку о целом ответе.
      if (this.#options.dialect !== 'anthropic') continue;
      const type = isRecord(part) && typeof part.type === 'string' ? part.type : 'часть';
      const name = `content[].${type}`;
      if (!this.facts.droppedParts.includes(name) && this.facts.droppedParts.length < 4) {
        this.facts.droppedParts.push(name);
      }
    }
    return text;
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
    // Придержанный хвост — раньше `[DONE]`, и здесь тоже: после этого кадра
    // клиент читать перестаёт, а хвост — это и весь ответ, начавшийся со
    // скобки, и недоразобранный забор. Без этой строки собранный из него вызов
    // уходил уже за `[DONE]`, то есть в никуда, а счётчик рапортовал успех.
    return this.#flushShim() + DONE_FRAME;
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
    const start = serializeFrame(
      'message_start',
      JSON.stringify({ type: 'message_start', message }),
    );
    // Без прослойки блок текста открывается сразу и остаётся единственным. С
    // прослойкой порядок блоков заранее неизвестен — первым вполне может идти
    // вызов, — и текст открывается по мере надобности.
    return this.#parser ? start : start + this.#startText();
  }

  /** Открыть блок текста под текущим номером. */
  #startText(): string {
    this.#textOpen = true;
    return serializeFrame(
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: this.#index,
        content_block: { type: 'text', text: '' },
      }),
    );
  }

  /** Закрыть текущий блок и перевести курсор на следующий. */
  #stopBlock(): string {
    const out = serializeFrame(
      'content_block_stop',
      JSON.stringify({ type: 'content_block_stop', index: this.#index }),
    );
    this.#index += 1;
    this.#textOpen = false;
    return out;
  }

  /** Завершение сообщения. Вызывается и на `[DONE]`, и на обрыве соединения. */
  #closeAnthropic(): string {
    let out = '';
    if (!this.#started) out += this.#openAnthropic();
    this.#finished = true;
    // Придержанный хвост отдаётся ДО закрытия: разборщик держит конец текста,
    // пока тот может оказаться началом тега, и без этого последние знаки ответа
    // (а с ними и незакрытый блок) просто не доехали бы.
    if (this.#parser) out += this.#flushShim();
    if (this.#textOpen || !this.#parser) out += this.#stopBlock();
    out += serializeFrame(
      'message_delta',
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: this.#stopReason(), stop_sequence: null },
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
