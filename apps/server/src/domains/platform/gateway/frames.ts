import type { PlatformViolationAction } from '@agentdeck/contracts';
import { parseFrame, serializeFrame, splitFrames } from '../../dlp/sse.ts';
import type { DriverViolationName, VendorFrame, VendorFrameKind } from '../drivers/driver.ts';
import { readViolations } from './status.ts';
import {
  anthropicMessageId,
  anthropicUsage,
  cachedTokensOf,
  errorBody,
  openAiUsage,
  stopReasonOf,
  upstreamErrorCode,
  type Dialect,
} from './dialect.ts';
import { expandContourAliases, strayAliases, strayPlatformLabels } from './tool-shim/aliases.ts';
import { claimedWithoutCall } from './tool-shim/claims.ts';
import type { ShimCall } from './tool-shim/parse.ts';
import { strictObject } from './tool-shim/repair.ts';
import { ThinkSplitter, withoutThink, type ThinkMode } from './think-tail.ts';
import { parseToolCalls, ToolStreamParser, type ShimEvent } from './tool-shim/stream.ts';
import { serverText, type TextLanguage } from '../../../lib/server-texts.ts';

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
 * - `platform_reasoning` отбрасывается: подделать подписанный блок размышлений
 *   диалекта Anthropic мост не может, а положить чужой текст в обычный ответ
 *   значило бы выдать размышление за ответ;
 * - `platform_guardrails` со `stream_interrupted` превращается в ТЕРМИНАЛЬНУЮ
 *   ошибку клиента: молча оборвавшийся поток клиент считает удачным ответом;
 * - финальный расход снимается для учёта, а наружу уходит только если клиент
 *   сам его просил (`stream_options.include_usage`).
 */

/** Конец потока в диалекте OpenAI — его ждёт половина клиентов. */
const DONE_FRAME = 'data: [DONE]\n\n';

/** Причина, которую видит клиент, когда поток кончился на полуслове. */
export const TRUNCATED_MESSAGE = serverText('gateway-answer-truncated');

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
  /** Id сообщения, выданный клиенту Anthropic (`anthropicMessageId`). Нет — клиент OpenAI. */
  messageId?: string;
  /** Названия сработавших проверок — только названия. */
  violations: string[];
  /** Имя проверки → исход, который принёс ЕЁ кадр (маска, обрыв); пустой список — только вердикт. */
  violationActions: Record<string, PlatformViolationAction[]>;
  /**
   * Контур замаскировал часть данных и всё-таки ответил (`platform_sanitized`).
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
  /**
   * Та сторона оборвала ответ СВОЕЙ ошибкой, назвав её кадром `{"error": {...}}`.
   *
   * Отдельно от `truncated`: там «кончилось на полуслове, причины нет», здесь
   * причина есть и она у человека должна быть своя. Сведённая к «оборвалось»,
   * она теряла главное — лимит частоты не отличался от переполненного окна, и
   * клиент повторял запрос, который повторять бессмысленно.
   */
  upstreamError?: { code: string; message: string };
  /**
   * Платформа прислала итоговый текст, который НЕ продолжает отданный потоком
   * (её проверки вывода поправили ответ, либо поток разошёлся с проверенным).
   * Цельное тело несёт итоговый; поток клиенту уже ушёл, и забрать его нельзя —
   * поэтому это факт следа, а не молчание.
   */
  rewritten?: 'diverged';
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
  /**
   * Сколько байт картинок приехало частями содержимого (Т9). В след идёт РАЗМЕР,
   * а не содержимое: журнал читает человек, и мегабайт base64 в нём не читается
   * ни глазами, ни поиском. Ноль — картинок в ответе не было.
   */
  imageBytes: number;
  /** Вызовов инструментов, собранных прослойкой из текста ответа (Т5.5). */
  toolCalls: number;
  /**
   * Вызовов, которые прислал САМ контур полем `tool_calls` (Т7, режим
   * `single_turn`). Отдельный счётчик, а не строка в `toolCalls`: там живёт
   * работа прослойки, и сводка по ней считается именно оттуда. Здесь —
   * инструменты контура, которые панель только перевела клиенту.
   */
  contourCalls: number;
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
  /** Часть входа, прочитанная моделью из кэша (`prompt_tokens_details`). */
  cachedTokens: number;
  /** Сколько знаков размышления снято с текста ответа (L9, `think-tail.ts`). */
  reasoningChars: number;
  /**
   * В тексте, отданном клиенту, был голый `</think>`: модель пишет размышления
   * текстом без открывающего тега. Конвейер записывает это фактом модели, и
   * следующие ответы держатся до тега.
   */
  bareThinkClose: boolean;
}

/** Что собралось из потока для клиента, просившего НЕ поток. */
export interface AssembledAnswer {
  text: string;
  /**
   * Части содержимого, которые не текст, — как их прислал контур (картинка едет
   * именно так, Т9). Потоком такая часть уходит клиенту в кадре байт в байт, и
   * цельное тело обязано нести её же: собранный из одного текста ответ молча
   * терял картинку у того клиента, который просил не поток.
   */
  parts: unknown[];
  /** Вызовы, собранные прослойкой: клиенту они уедут полем его диалекта. */
  calls: ShimCall[];
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
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
   * Суффикс id сообщения этого запроса (Anthropic). Делает id уникальным даже
   * при одинаковых id контура: по нему лента находит ответ со сжатием истории.
   */
  messageIdSuffix?: string;
  /**
   * Чей это поток. Обязателен: «поток ничей» — это молчаливое обещание, что
   * вендорных кадров не будет, а поток, в котором они всё-таки есть, читается
   * тогда как обычный OpenAI и теряет вердикты целиком.
   */
  driver: FrameDriver;
  /** Язык панели: телу отказа, которое печатает CLI, переводить больше негде. */
  language?: TextLanguage;
  /**
   * Причина обрыва точнее общей — например, потолок ответа платформы
   * (`ceilingCutMessage`). Спрашивается в момент обрыва: раньше неизвестно,
   * сколько длился ответ. `undefined` — остаётся `TRUNCATED_MESSAGE`.
   */
  truncatedReason?: () => string | undefined;
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
  /**
   * Метки, которыми подменяет данные САМА платформа (`driver.placeholderPattern`),
   * и тело, которое ушло к ней наверх.
   *
   * Метка этого вида в аргументе вызова — значение, которое платформа спрятала и
   * не вернула, но только при двух условиях сразу: платформа сказала, что
   * подменяла (`facts.masked`), и ровно такой строки не было в отправленном теле.
   * Без второго условия `[TODO_1]` из файла человека останавливал бы ход.
   */
  placeholders?: { pattern: RegExp; sent: string };
  /**
   * Как отделять размышления, пришедшие текстом (L9): `tail` — модель уже
   * замечена с голым `</think>`, держим всё до тега; `lead` — только ответ,
   * начатый с `<think>`. Нет ключа — `lead`.
   */
  think?: ThinkMode;
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

/**
 * Годится ли ключ карты подмены контура в метки: буква, цифра и хотя бы один
 * разделитель (`[EMAIL_1]`, `ORG_7`, `<<PERSON-3>>`).
 *
 * Карта разворачивается заменой строки по ВСЕМ строковым листьям аргументов, и
 * форму ключа выбираем не мы. Ключ «1» или «IP» переписал бы содержимое
 * записываемого файла; наша маска защищена формой своей метки, чужая — только
 * этой проверкой (ревью Т5, m12). Номер обязателен не из вкуса: подмена
 * нумерует сущности одного вида, иначе двух людей было бы не различить. Шаблон
 * метки у контура настраивается (у платформы компании — админом правила), поэтому здесь
 * форма любой метки, а не одного драйвера.
 */
function isSubstitutionKey(key: string): boolean {
  return /\p{L}/u.test(key) && /\d/.test(key) && /[^\p{L}\d]/u.test(key);
}

/**
 * Сколько НЕтекстовых частей содержимого шлюз держит для цельного тела (Т9).
 * Каждая — мегабайтная картинка в base64, и без потолка ответ лежал бы в памяти
 * дважды: кусками потока и собранным телом.
 */
const MAX_CONTENT_PARTS = 4;

/**
 * Размер части ответа в байтах — для следа запроса. Считается по её собственному
 * JSON: у картинки это base64, то есть примерно на треть больше самих байтов. В
 * след идёт порядок величины, а не точный вес файла, — и это ровно то, что нужно
 * человеку, читающему «сколько проехало».
 */
function partBytes(part: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(part) ?? '', 'utf8');
  } catch {
    // Часть с циклом внутри JSON не переживёт. Она всё равно уедет клиенту как
    // есть — сказать про её размер нечего, но терять из-за этого ответ нельзя.
    return 0;
  }
}

/** Защита данных выключена: словаря меток нет, и остановить ход нечему. */
const EMPTY_ALIASES: ReadonlyMap<string, string> = new Map();

/**
 * Текст остановки — один на оба пути, поток и цельное тело. Написанный дважды,
 * он разошёлся бы, и человек читал бы разные объяснения одной беды.
 */
export function maskStopMessage(names: string): string {
  return serverText('gateway-mask-unrestorable', { names });
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
  /** Где лежит название нарушения в перечне вердикта (`driver.violationNames`). */
  violationNames?: readonly DriverViolationName[];
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
  /**
   * Весь текст ответа ровно так, как его прислала платформа, — до прослойки.
   * С ним сверяется итоговый текст платформы: `#text` без блоков вызова с ним
   * не сравнить.
   */
  #raw = '';
  /** Итоговый текст платформы, разошедшийся с потоком (`facts.rewritten`). */
  #replacement: string | undefined;
  /** В потоке был расход — клиенту, просившему его, он уедет и с прослойкой. */
  #usageSeen = false;
  /** Метки вызовов контура, которые нечем развернуть: решает закрытие ответа. */
  #contourStray: string[] = [];
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
  /**
   * Вызовы, которые прислал сам контур (Т7, `single_turn`), — по номеру из его
   * же кадров. Копятся кусками: имя приезжает в первом, аргументы дописываются
   * следующими, и целым вызов становится только к концу ответа.
   */
  readonly #contourCalls = new Map<number, { id: string; name: string; args: string }>();
  /** Те же вызовы, собранные целиком. Считаются однажды — вместе с пометками. */
  #contourReady: ShimCall[] | undefined;
  /**
   * Части содержимого, которые не текст (картинка контура, Т9). Держатся вне
   * `facts` намеренно: в след идёт только их РАЗМЕР, а сами байты уезжают
   * клиенту цельным телом и в журнал панели не попадают.
   */
  readonly #parts: unknown[] = [];

  readonly facts: FrameFacts = {
    stages: [],
    summarized: false,
    violations: [],
    violationActions: {},
    masked: false,
    interrupted: false,
    truncated: false,
    unknownFrames: [],
    toolsDropped: false,
    droppedParts: [],
    imageBytes: 0,
    toolCalls: 0,
    contourCalls: 0,
    toolFlaws: [],
    maskStop: [],
    claimedWithoutCall: false,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningChars: 0,
    bareThinkClose: false,
  };
  /** Размышления, пришедшие текстом ответа, — до прослойки и до клиента (L9). */
  readonly #think: ThinkSplitter;

  constructor(options: TranslatorOptions) {
    this.#options = options;
    this.#model = options.model;
    this.#think = new ThinkSplitter(options.think ?? 'lead');
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
      out += this.#releaseThink();
      return out + this.#abortShim() + this.#terminal(this.truncationMessage(), 'api_error');
    }

    if (this.#finished) return out;
    out += this.#releaseThink();
    this.#finished = true;
    // Контур назвал причину остановки, но `[DONE]` не прислал: закрываем сами —
    // половина клиентов ждёт именно его, а ответ и правда закончен.
    return (
      out + (this.#options.dialect === 'anthropic' ? this.#closeAnthropic() : this.#closeOpenAi())
    );
  }

  /** Язык панели этого прогона — им переводится тело отказа для CLI. */
  get language(): TextLanguage {
    return this.#options.language ?? 'ru';
  }

  /** Чем назвать недосказанный ответ: причиной, если она известна, иначе общим обрывом. */
  truncationMessage(): string {
    return this.#options.truncatedReason?.() ?? TRUNCATED_MESSAGE;
  }

  /**
   * Прервать поток чужой бедой — обрывом связи с контуром, отказом транспорта.
   * Клиент обязан увидеть ошибку: молча закрытый поток он покажет как удачный
   * короткий ответ.
   */
  fail(message: string): string {
    if (this.#closed) return '';
    this.facts.truncated = true;
    return this.#releaseThink() + this.#abortShim() + this.#terminal(message, 'api_error');
  }

  /** Ответ целиком — для клиента, который просил не поток. */
  assembled(): AssembledAnswer {
    const own =
      this.#replacement === undefined
        ? { text: this.#text, calls: this.#calls }
        : this.#replaced(this.#replacement);
    // Вызовы контура в диалекте Anthropic уже лежат в `#calls` — их положило
    // туда закрытие сообщения. В своём диалекте закрытия нет: кадры уходили
    // клиенту как есть, а цельное тело собирается ЗДЕСЬ, и без этой строки
    // вызов контура терялся бы ровно у того клиента, который просил не поток.
    const calls =
      this.#options.dialect === 'anthropic'
        ? own.calls
        : [...own.calls, ...this.#buildContourCalls()];
    // Метка в вызове контура, которую нечем развернуть: цельное тело не уходит
    // вовсе, и остановку объявляет конвейер по этому факту.
    if (this.#contourStray.length > 0 && this.facts.maskStop.length === 0) {
      this.facts.maskStop = this.#contourStray;
    }
    return {
      text: own.text,
      parts: this.#parts,
      calls,
      finishReason: this.#finishOf(calls.length),
      promptTokens: this.facts.promptTokens,
      completionTokens: this.facts.completionTokens,
      totalTokens: this.facts.totalTokens,
      cachedTokens: this.facts.cachedTokens,
      model: this.#model,
      id: this.#id || `chatcmpl-${Date.now().toString(36)}`,
    };
  }

  #frame(raw: string): string {
    const parsed = parseFrame(raw);
    if (parsed.data.length === 0) return this.#keepalive(raw);
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

    if (isRecord(payload)) {
      // Расход читается из ЛЮБОГО кадра, до разбора вида. LiteLLM, а с ним и
      // платформа компании с OpenRouter, кладут его рядом с непустым `choices`; ждавший его
      // только в кадре с пустым `choices` разборщик считал ноль на каждом ответе
      // — и бюджет ключа, и счёт окна у Claude Code молча стояли на месте.
      this.#takeUsage(payload);
      // Конверт ошибки — терминальный кадр той стороны, и он старше
      // `finish_reason` рядом с ним: OpenRouter шлёт оба в одном чанке, и
      // «причина остановки есть» читалась удачным концом оборванного ответа.
      if (payload.error !== undefined && payload.error !== null) {
        return this.#upstreamFailure(
          isRecord(payload.error)
            ? payload.error
            : { message: typeof payload.error === 'string' ? payload.error : '' },
        );
      }
    }

    const driver = this.#options.driver;
    const vendorFrame = isRecord(payload) ? driver.readFrame(payload) : undefined;
    if (!vendorFrame) {
      const kind = classifyFrame(payload, driver);
      if (kind === 'delta') return this.#delta(payload as Record<string, unknown>);
      if (kind === 'usage') return this.#usage(data);
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
        ? this.#usage(JSON.stringify(clean))
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

  #stage(stage: string): void {
    if (stage && !this.facts.stages.includes(stage) && this.facts.stages.length < MAX_STAGES) {
      this.facts.stages.push(stage);
    }
  }

  /** Вендорный кадр: наружу не идёт никогда, в панель — фактом. */
  #vendor(frame: VendorFrame): string {
    if (frame.kind === 'status') {
      const stage = frame.stage ?? '';
      this.#stage(stage);
      // compromise: context-managed — сжатие истории видно только этим кадром, поэтому его снимаем в панель
      if (stage === 'summarizing') this.facts.summarized = true;
      return '';
    }
    if (frame.kind === 'sanitized') {
      // Сам факт правки — отдельно от названий: контур вправе прислать кадр без
      // единого имени, и тогда «нарушений нет» означало бы «ничего не меняли».
      this.facts.masked = true;
      this.#addViolations(
        readViolations(frame.verdict, this.#options.driver.violationNames),
        'masked',
      );
      return '';
    }
    if (frame.kind === 'guardrails') {
      const before = this.facts.violations.length;
      this.#addViolations(
        readViolations(frame.verdict, this.#options.driver.violationNames),
        frame.interrupted ? 'interrupted' : undefined,
      );
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
        this.facts.masked = true;
        if (!isSubstitutionKey(alias)) {
          this.#note(`${frame.field}: ключ карты не похож на метку`);
          continue;
        }
        this.#contourAliases.set(alias, value);
      }
      return '';
    }
    if (frame.kind === 'replacement') return this.#replace(frame.text ?? '');
    if (frame.kind === 'reasoning') {
      // Наружу не идёт: подделать подписанный блок размышлений мост не может. Но
      // стадией в след — это единственное свидетельство, что правило
      // «Размышления модели» до модели дошло (аудит MD-02).
      this.#stage('reasoning');
      return '';
    }
    // Кадры чата платформы: отбрасываем молча — они не про API-клиента.
    return '';
  }

  /**
   * Размышление, пришедшее строкой `content`, снимается ДО всего остального:
   * до прослойки (вызов, прикинутый в рассуждении, не выполняется), до сборки
   * текста и до клиента. Кадр своего диалекта уходит байт в байт — поэтому
   * снятый текст переписывается в его же поле, а не в копию, которую никто не
   * отправит. Незакрытое размышление отдаётся текстом только в конце потока
   * (`#releaseThink`), не на причине остановки: платформа с гейтом вывода шлёт
   * придержанный хвост ПОСЛЕ чанка с `finish_reason`.
   */
  #splitThink(
    payload: Record<string, unknown>,
    choice: unknown,
  ): { payload: Record<string, unknown>; delta: Record<string, unknown> } {
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : {};
    if (!isRecord(choice) || typeof delta.content !== 'string') return { payload, delta };
    const incoming = delta.content;
    const content = this.#think.push(incoming);
    this.facts.reasoningChars = this.#think.reasoningChars;
    this.facts.bareThinkClose = this.#think.sawBareClose;
    if (this.#think.reasoningChars > 0) this.#stage('reasoning');
    if (content === incoming) return { payload, delta };
    const nextDelta = { ...delta, content };
    return {
      payload: { ...payload, choices: [{ ...choice, delta: nextDelta }] },
      delta: nextDelta,
    };
  }

  /**
   * Поток кончился, а размышление так и не закрылось: придержанное — это ответ
   * модели, которая на этот раз не размышляла. Уходит обычной дельтой, через
   * прослойку, раньше закрытия или ошибки.
   */
  #releaseThink(): string {
    if (this.#closed) return '';
    const held = this.#think.end();
    if (!held) return '';
    return this.#delta({
      id: this.#id,
      object: 'chat.completion.chunk',
      model: this.#model,
      choices: [{ index: 0, delta: { content: held }, finish_reason: null }],
    });
  }

  /** Обычный чанк: клиенту — в его диалекте, себе — текст для сборки. */
  #delta(source: Record<string, unknown>): string {
    let payload = source;
    if (this.#closed) return '';
    if (typeof payload.id === 'string' && !this.#id) this.#id = payload.id;
    if (typeof payload.model === 'string') this.#model = payload.model;

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const finishReason =
      isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
    const split = this.#splitThink(payload, choice);
    payload = split.payload;
    const delta = split.delta;
    const text = this.#contentText(delta.content);
    // «Кончилось ошибкой» — не конец ответа. Текст того же чанка ещё доезжает,
    // а следом клиент получает ошибку: причину `error` мост в `end_turn` не
    // переводит никогда.
    if (finishReason === 'error' && isRecord(choice)) {
      const kept = text
        ? this.#delta({ ...payload, choices: [{ ...choice, finish_reason: null }] })
        : '';
      return kept + this.#upstreamFailure({});
    }
    if (text) this.#raw += text;
    if (finishReason) {
      this.#finishReason = finishReason;
      // Причина остановки — второе (кроме `[DONE]`) слово контура о том, что
      // ответ закончен: часть шлюзов закрывает поток сразу после неё.
      this.#complete = true;
    }

    // Прослойка включена: текст сначала проходит разбор — вызов, уехавший
    // клиенту текстом, агент показывает человеку вместо того, чтобы выполнить.
    if (this.#parser) {
      // Инструменты контура и прослойка — взаимное исключение, и обычной дорогой
      // такой запрос не собрать; приехать он может разворотом чужого архива.
      // Кадр вызова здесь пересобирается без `tool_calls`, поэтому вызов контура
      // до клиента не доедет — и это НАЗЫВАЕТСЯ, а не пропадает молча.
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        this.#note('вызов контура при включённой прослойке');
      }
      return this.#shimDelta(payload, this.#parser.push(text));
    }

    // Вызов, который контур сделал САМ (Т7, `platform_tool_mode: single_turn`).
    // Копится здесь, а отдаётся в конце ответа: в диалекте OpenAI кадр уходит
    // клиенту как есть, а в диалекте Anthropic вызова нет вовсе — до ревью Т7
    // (M1) клиент получал `stop_reason: tool_use` и ни одного блока `tool_use`,
    // то есть ответ, невалидный по протоколу, и ни строки о потере.
    this.#collectContourCalls(delta.tool_calls);

    if (text) this.#text += text;
    if (this.#options.dialect !== 'anthropic') {
      // Диалект тот же: кадр уходит как пришёл, байт в байт. Пересобирать его
      // значило бы терять поля, которых мост не знает, — и молча. Кроме расхода:
      // его клиент получает, только если просил, в каком бы чанке он ни ехал.
      if (payload.usage !== undefined && !this.#options.includeUsage) {
        const { usage: _usage, ...rest } = payload;
        return serializeFrame(undefined, JSON.stringify(rest));
      }
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
  #shimDelta(payload: Record<string, unknown>, events: readonly ShimEvent[]): string {
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
    // Причина остановки здесь НЕ отдаётся и хвост разбора не сбрасывается —
    // оба ждут `[DONE]` (или конца потока). Платформа с гейтом проверок вывода
    // шлёт придержанный хвост ответа ПОСЛЕ чанка с `finish_reason`
    // (так устроен её маршрут чата): сброшенный на причине разборщик терял вызов,
    // закрывающий тег которого ехал в этом хвосте.
    return out;
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

  /**
   * Куски вызова контура: имя приезжает однажды, аргументы дописываются.
   *
   * Собираем ВСЕГДА, а не только для диалекта Anthropic: счётчик вызовов
   * контура человек читает и там, где кадр ушёл клиенту как есть, — иначе
   * «контур звал свои инструменты» видно только у одного из двух видов CLI.
   */
  #collectContourCalls(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const index = typeof item.index === 'number' ? item.index : this.#contourCalls.size;
      const fn = isRecord(item.function) ? item.function : {};
      const held = this.#contourCalls.get(index) ?? { id: '', name: '', args: '' };
      this.#contourCalls.set(index, {
        id: typeof item.id === 'string' && item.id ? item.id : held.id,
        name: typeof fn.name === 'string' && fn.name ? fn.name : held.name,
        args: held.args + (typeof fn.arguments === 'string' ? fn.arguments : ''),
      });
    }
    this.facts.contourCalls = this.#contourCalls.size;
  }

  /**
   * Куски вызовов контура — цельными вызовами. Считается один раз: пометки об
   * испорченных вызовах не должны вставать дважды.
   *
   * Безымянный кусок вызовом не становится — он называется пометкой, потому что
   * блок `tool_use` без имени клиент разбирает как поломку панели.
   */
  #buildContourCalls(): ShimCall[] {
    if (this.#contourReady) return this.#contourReady;
    const ready: ShimCall[] = [];
    for (const call of this.#contourCalls.values()) {
      if (!call.name) {
        this.#noteFlaw(serverText('gateway-flaw-contour-unnamed'));
        continue;
      }
      // Строго, без ремонта: аргументы собрал сервер контура, а не модель, и
      // «почини как-нибудь» здесь означало бы выполнить догадку над файлами
      // человека. Пусто — это законный вызов без аргументов.
      const args = call.args.trim() ? strictObject(call.args) : {};
      if (!args) {
        this.#noteFlaw(
          serverText('gateway-joined', {
            message: serverText('gateway-flaw-contour-args'),
            detail: call.name,
          }),
        );
        continue;
      }
      // Вызов контура едет в файлы человека так же, как вызов прослойки, и метки
      // в нём проверяются так же. Решение — за закрытием ответа: здесь вызов
      // только не становится готовым. В своём диалекте потоком кадры вызова уже
      // ушли клиенту байт в байт, и остановить их нечем — проверка работает там,
      // где вызов собирает сам мост: у Anthropic и в цельном теле.
      const prepared = this.#prepareCall({
        id: call.id || `contour_${ready.length}`,
        name: call.name,
        arguments: args,
        round: 'none',
      });
      if ('stray' in prepared) {
        for (const token of prepared.stray) {
          if (!this.#contourStray.includes(token)) this.#contourStray.push(token);
        }
        continue;
      }
      ready.push(prepared.call);
    }
    this.#contourReady = ready;
    return ready;
  }

  /**
   * Вызовы контура — блоками `tool_use` клиенту диалекта Anthropic.
   *
   * Зовётся один раз, на закрытии сообщения: раньше конца ответа аргументы ещё
   * не дописаны, и блок уехал бы с половиной JSON.
   */
  #flushContourCalls(): string {
    if (this.#options.dialect !== 'anthropic' || this.#contourCalls.size === 0) return '';
    const ready = this.#buildContourCalls();
    if (this.#contourStray.length > 0) return this.#maskStop(this.#contourStray);
    let out = '';
    for (const call of ready) {
      this.#calls.push(call);
      out += this.#renderCall(call, {});
    }
    return out;
  }

  /** Пометка о вызове, который вызовом не стал, — без повторов. */
  #noteFlaw(reason: string): void {
    if (!this.facts.toolFlaws.includes(reason)) this.facts.toolFlaws.push(reason);
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

  /**
   * Причина остановки для клиента OpenAI: вызов был — значит ход не закончен.
   *
   * И обратно: `tool_calls` без единого вызова клиент читает как «ход идёт» и
   * ждёт вызов, которого нет. Контур вправе назвать такую причину и тогда, когда
   * собрать вызов не вышло, — это называется пометкой, а клиенту уходит `stop`.
   */
  #finishOf(calls: number): string {
    if (calls > 0) return 'tool_calls';
    if (this.#finishReason === 'tool_calls') {
      this.#noteFlaw(serverText('gateway-flaw-stop-without-call'));
      return 'stop';
    }
    return this.#finishReason || 'stop';
  }

  /**
   * Закрытие ответа в диалекте OpenAI: хвост разбора, причина остановки, расход,
   * `[DONE]` — именно в этом порядке и именно здесь, а не на `finish_reason`.
   *
   * Без прослойки кадры ушли клиенту как есть, причина остановки — вместе с ними,
   * и дописать остаётся только `[DONE]`.
   */
  #closeOpenAi(): string {
    let out = this.#flushShim();
    // Сброс хвоста мог остановить ход по метке — ошибка с `[DONE]` уже ушла.
    if (this.#closed) return out;
    if (this.#parser) {
      // Саму причину нельзя ни потерять, ни оставить прежней: клиент, получивший
      // вызов при `finish_reason: "stop"`, выполняет его и на этом заканчивает
      // ход — ровно так, как если бы вызова не было.
      out += this.#openAiFrame({}, {}, this.#finishOf(this.#calls.length));
      // Пересобранные кадры расхода не несут, а просивший его клиент ждёт его
      // отдельным кадром с пустым `choices` — после причины остановки.
      if (this.#options.includeUsage && this.#usageSeen) {
        out += serializeFrame(
          undefined,
          JSON.stringify({
            id: this.#id,
            object: 'chat.completion.chunk',
            model: this.#model,
            choices: [],
            usage: openAiUsage(
              this.facts.promptTokens,
              this.facts.completionTokens,
              this.facts.totalTokens,
              this.facts.cachedTokens,
            ),
          }),
        );
      }
    }
    return out + DONE_FRAME;
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
      if ('stray' in prepared) {
        // Пометки — ДО раннего выхода: ход, остановленный жёстче всех, иначе
        // единственный уезжал бы в трассу без своих изъянов («забор с
        // протоколом», «весь ответ вызовом не стал»), и «вызовов не было»
        // читалось бы как сломанная панель (ревью Т13).
        this.#noteCalls();
        return out + this.#maskStop(prepared.stray);
      }
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
    // Изъяны, записанные разборщиком ДО обрыва, — не синтез, а уже состоявшийся
    // факт: без них трасса оборванного хода говорит «всё было чисто» именно там,
    // где модель цитировала протокол (ревью Т13). Вызовов здесь по-прежнему не
    // появляется — `#calls` не пополняется ничем.
    this.#noteCalls();
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
    const platform = this.#options.placeholders;
    // Метка платформы спрашивается, только если платформа сама сказала, что
    // подменяла: без этого слова `[TODO_1]` в тексте файла — просто текст.
    if (platform && this.facts.masked) {
      for (const token of strayPlatformLabels(args, platform.pattern, platform.sent)) {
        if (!stray.includes(token)) stray.push(token);
      }
    }
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
    // compromise: mask-unrestorable — метку, которую нечем развернуть, вызов в файл не пропускает
    this.facts.maskStop = stray;
    this.facts.interrupted = true;
    const names = stray.join(', ');
    const reason = `mask-unrestorable: ${names}`;
    if (!this.facts.toolFlaws.includes(reason)) this.facts.toolFlaws.push(reason);
    return this.#terminal(maskStopMessage(names), 'content_policy_violation');
  }

  /** Причина остановки в диалекте Anthropic: вызов перебивает любую другую. */
  #stopReason(): string {
    if (this.#calls.length === 0 && this.#finishReason === 'tool_calls') {
      this.#noteFlaw(serverText('gateway-flaw-stop-without-call'));
    }
    return stopReasonOf(this.#finishReason || 'stop', this.#calls.length);
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
      if (this.#options.dialect !== 'anthropic') {
        this.#keepPart(part);
        continue;
      }
      const type = isRecord(part) && typeof part.type === 'string' ? part.type : 'часть';
      const name = `content[].${type}`;
      if (!this.facts.droppedParts.includes(name) && this.facts.droppedParts.length < 4) {
        this.facts.droppedParts.push(name);
      }
    }
    return text;
  }

  /**
   * Часть содержимого, которая не текст, — для цельного тела (Т9).
   *
   * Потолок есть: ответ с десятком картинок иначе лежал бы в памяти панели
   * дважды — кусками потока и собранным телом. Превышение НАЗЫВАЕТСЯ пометкой
   * потери, потому что молча обнулённая картинка и есть тот самый пустой ответ,
   * о котором человек ничего не узнаёт.
   */
  #keepPart(part: unknown): void {
    this.facts.imageBytes += partBytes(part);
    if (this.#parts.length >= MAX_CONTENT_PARTS) {
      const name = 'content[].сверх предела';
      if (!this.facts.droppedParts.includes(name)) this.facts.droppedParts.push(name);
      return;
    }
    this.#parts.push(part);
  }

  /**
   * Кадр только с расходом (`choices: []`). Учёт снят раньше, в `#takeUsage`;
   * здесь решается одно — ехать ли кадру клиенту. С прослойкой он не едет сейчас:
   * причина остановки ждёт `[DONE]`, а расход обязан прийти после неё.
   */
  #usage(raw: string): string {
    if (this.#closed) return '';
    if (this.#options.dialect === 'anthropic' || this.#parser) return '';
    return this.#options.includeUsage ? serializeFrame(undefined, raw) : '';
  }

  /** Расход из любого кадра; последний ненулевой побеждает. */
  #takeUsage(payload: Record<string, unknown>): void {
    if (!isRecord(payload.usage)) return;
    const prompt = numberOf(payload.usage.prompt_tokens);
    const completion = numberOf(payload.usage.completion_tokens);
    const total = numberOf(payload.usage.total_tokens) || prompt + completion;
    this.#usageSeen = true;
    // Нулевой расход рядом с ненулевым — это промежуточный чанк, а не итог:
    // поверх итога он записал бы ноль.
    if (total === 0) return;
    this.facts.promptTokens = prompt;
    this.facts.completionTokens = completion;
    this.facts.totalTokens = total;
    this.facts.cachedTokens = cachedTokensOf(payload.usage);
  }

  #done(): string {
    this.#complete = true;
    if (this.#closed) return '';
    const held = this.#releaseThink();
    this.#finished = true;
    // Придержанный хвост — раньше `[DONE]`, и здесь тоже: после этого кадра
    // клиент читать перестаёт, а хвост — это и весь ответ, начавшийся со
    // скобки, и недоразобранный забор. Без этого собранный из него вызов уходил
    // уже за `[DONE]`, то есть в никуда, а счётчик рапортовал успех.
    return (
      held + (this.#options.dialect === 'anthropic' ? this.#closeAnthropic() : this.#closeOpenAi())
    );
  }

  /**
   * Комментарий потока (`: keepalive`, `: OPENROUTER PROCESSING`). Та сторона
   * шлёт его, пока думает сама — долгий цикл инструментов у платформы компании идёт минутами.
   * Проглоченный, он оставлял клиента в тишине, и клиент с таймаутом простоя
   * рвал живой ответ. Anthropic ждёт `ping`, OpenAI — тот же комментарий.
   */
  #keepalive(raw: string): string {
    if (this.#closed || !/^:/m.test(raw)) return '';
    return this.#options.dialect === 'anthropic'
      ? serializeFrame('ping', JSON.stringify({ type: 'ping' }))
      : ': keepalive\n\n';
  }

  /**
   * Ошибка, которую та сторона назвала кадром. Терминальная, как и обрыв
   * проверками, но причина у неё своя и уходит клиенту словами той стороны.
   *
   * Поток при этом ЗАКОНЧЕН, а не оборван: `[DONE]` за конвертом ошибки не идёт
   * по устройству (`provider_errors.py sse_error_event`), и без этой отметки
   * конец потока дописал бы поверх настоящей причины «ответ оборвался».
   */
  #upstreamFailure(error: Record<string, unknown>): string {
    const code = upstreamErrorCode(error);
    const said = typeof error.message === 'string' ? error.message.trim().slice(0, 500) : '';
    const message = said || serverText('gateway-upstream-unnamed-error');
    this.#complete = true;
    if (this.#closed) return '';
    this.facts.upstreamError = { code, message };
    return (
      this.#releaseThink() +
      this.#abortShim() +
      this.#terminal(serverText('gateway-upstream-aborted', { message }), code)
    );
  }

  /**
   * Итоговый текст платформы.
   *
   * Совпал с потоком — сказать нечего. Продолжает поток — клиенту уходит только
   * недоставленный хвост, обычной дельтой и через прослойку: закрывающий тег
   * вызова вправе оказаться именно в нём. Разошёлся — забрать отданное нельзя:
   * это факт следа, а итоговый текст несёт цельное тело.
   */
  #replace(said: string): string {
    // Итог платформы — текст модели целиком, с размышлением; поток его уже снял.
    // Сравнивать надо очищенное с очищенным, иначе любой такой ответ «разошёлся».
    const final = this.#think.reasoningChars > 0 ? withoutThink(said) : said;
    if (this.#closed || final === this.#raw) return '';
    if (final.startsWith(this.#raw)) {
      return this.#delta({
        id: this.#id,
        object: 'chat.completion.chunk',
        model: this.#model,
        choices: [{ index: 0, delta: { content: final.slice(this.#raw.length) } }],
      });
    }
    this.facts.rewritten = 'diverged';
    this.#replacement = final;
    return '';
  }

  /**
   * Итоговый текст платформы — текстом и вызовами для цельного тела. Тем же
   * разборщиком и с теми же проверками меток, что и поток: второй путь «на
   * цельное тело» разошёлся бы с первым молча.
   */
  #replaced(final: string): { text: string; calls: ShimCall[] } {
    const shim = this.#options.shim;
    if (!shim) return { text: final, calls: [] };
    const parsed = parseToolCalls(final, { allowed: shim.allowed });
    const calls: ShimCall[] = [];
    for (const call of parsed.calls) {
      const prepared = this.#prepareCall(call);
      if ('stray' in prepared) {
        this.#maskStop(prepared.stray);
        continue;
      }
      calls.push(prepared.call);
    }
    for (const flaw of parsed.flaws) {
      this.#noteFlaw(flaw.name ? `${flaw.reason}: ${flaw.name}` : flaw.reason);
    }
    this.facts.toolCalls = calls.length;
    return { text: parsed.text, calls };
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
      ? serverText('gateway-checks-stopped-named', { names })
      : serverText('gateway-checks-stopped');
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
        JSON.stringify(errorBody('anthropic', message, code, this.language)),
      );
    }
    return (
      serializeFrame(
        undefined,
        JSON.stringify(errorBody('openai-compat', message, code, this.language)),
      ) + DONE_FRAME
    );
  }

  /** Id сообщения клиенту: считается один раз и остаётся в фактах для следа. */
  #anthropicId(): string {
    this.facts.messageId ??= anthropicMessageId(this.#id, this.#options.messageIdSuffix);
    return this.facts.messageId;
  }

  /** Начало сообщения в диалекте Anthropic — до первой дельты его нет. */
  #openAnthropic(): string {
    this.#started = true;
    const message = {
      id: this.#anthropicId(),
      type: 'message',
      role: 'assistant',
      model: this.#model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: anthropicUsage(this.facts.promptTokens, 0, this.facts.cachedTokens),
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
    // Сброс хвоста остановил ход по метке: `event: error` уже ушёл, и
    // `message_stop` после него клиент прочёл бы удачным концом.
    if (this.#closed) return out;
    // Вызовы контура — после текста и до причины остановки: клиент, увидевший
    // `stop_reason: tool_use` раньше блока, считает ответ испорченным. Блок
    // текста закрывает первый же вызов, поэтому второй раз его закрывать нельзя.
    const contour = this.#flushContourCalls();
    if (this.#closed) return out + contour;
    if (contour) out += contour;
    else if (this.#textOpen || !this.#parser) out += this.#stopBlock();
    out += serializeFrame(
      'message_delta',
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: this.#stopReason(), stop_sequence: null },
        // Расход входа известен только к концу потока (кадр `usage` приходит
        // последним), а `message_start` ушёл на первой дельте с нулём. Anthropic
        // и сам отдаёт итоговый расход здесь — иначе строка таблицы
        // «usage.input_tokens ← usage.prompt_tokens» врала бы в потоке.
        usage: anthropicUsage(
          this.facts.promptTokens,
          this.facts.completionTokens,
          this.facts.cachedTokens,
        ),
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
  #addViolations(names: string[], action?: PlatformViolationAction): void {
    for (const name of names) {
      if (!this.facts.violations.includes(name)) {
        if (this.facts.violations.length >= MAX_VIOLATIONS) {
          this.#note('перечень проверок обрезан');
          return;
        }
        this.facts.violations.push(name);
      }
      const own = (this.facts.violationActions[name] ??= []);
      if (action && !own.includes(action)) own.push(action);
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
