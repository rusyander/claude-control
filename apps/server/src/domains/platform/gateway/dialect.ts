import type { DlpApiKind } from '../../dlp/api-shapes.ts';
import type { DriverRequestField } from '../drivers/driver.ts';
import {
  encodeToolResult,
  encodeToolUse,
  shimOpenAiRequest,
  toolNamesById,
} from './tool-shim/encode.ts';
import { readTools, systemAddendum, type ShimTool } from './tool-shim/protocol.ts';
import {
  collectNativeTrace,
  emptyTraces,
  nativeToolChoice,
  nativeToolList,
  SERVER_TOOL_LOSS,
  type NativeTraces,
} from './native-tools.ts';
import { localizeText, type TextLanguage } from '../../../lib/server-texts.ts';
import { clientToolsTravel, type PlatformClientTools } from '@agentdeck/contracts/platform-presets';

/**
 * Перевод диалектов: клиент говорит по-Anthropic, контур — по-OpenAI.
 *
 * ТАБЛИЦА НАПИСАНА ДО КОДА и живёт данными, а не расползается по условиям в
 * трёх функциях: перевод — самая опасная часть шлюза, и единственный способ
 * отвечать за него — держать перечень соответствий в одном месте, где его
 * видно целиком, и прогонять тестом каждую строку.
 *
 * Второе, ради чего таблица существует: ЧТО НЕ ПЕРЕНОСИТСЯ. Мост, который
 * молча теряет половину запроса, хуже отсутствия моста — человек считает, что
 * модель видела инструменты, размышления и документы, а она их не видела.
 * Поэтому каждая потеря названа строкой таблицы, попадает в след запроса и
 * подписана компромиссом `dialect-bridge`.
 *
 * Направление здесь ровно одно: наверх уходит диалект OpenAI (справочник §5).
 * Обратно ответ переводится в тот диалект, на котором спросил клиент. Мост
 * работает только там, где у платформы нет родной ручки Anthropic: объявленная
 * манифестом, она принимает запрос как есть (`anthropic-native.ts`).
 */

/** Диалект — тот же словарь форм, что у прокси защиты данных: второго нет. */
export type Dialect = DlpApiKind;

/** Что мост делает с полем. */
export type DialectFate =
  /** Переносится как есть. */
  | 'mapped'
  /** Переносится под другим именем. */
  | 'renamed'
  /** Переносится частично: часть смысла теряется, и она названа. */
  | 'lossy'
  /** Не переносится вовсе. */
  | 'dropped'
  /**
   * Переносится ПРОСЛОЙКОЙ, текстом протокола (Т5). Не `mapped`: поля своего
   * у контура по-прежнему нет, и человек должен читать в следе именно это —
   * «доехало не полем, а текстом», иначе он ищет причину не там.
   */
  | 'shimmed';

export interface DialectRow {
  /** Поле в диалекте Anthropic — то, что присылает клиент. */
  anthropic: string;
  /** Поле в диалекте OpenAI — то, что понимает контур. Пусто — не доезжает. */
  openai: string;
  fate: DialectFate;
  /** Почему так. Этот текст панель показывает человеку не переводя. */
  note: string;
  /**
   * Что с полем делает ВКЛЮЧЁННАЯ прослойка инструментов. Есть только у трёх
   * строк, и только у них судьба зависит от настройки: таблица обязана
   * говорить правду в обоих состояниях, а не в том, которое было первым.
   */
  withShim?: { fate: DialectFate; note: string };
  /**
   * Что с полем делает мост у платформы, принимающей инструменты полем
   * (`clientTools: 'native'`). Та же причина, что у `withShim`: судьба этих строк
   * зависит от драйвера, и таблица обязана говорить правду у каждого.
   */
  native?: { fate: DialectFate; note: string };
}

/**
 * Соответствия. Порядок — от главного к частному; он же порядок показа.
 *
 * Строки с `fate: 'dropped'` — не забытые, а СОЗНАТЕЛЬНО не перенесённые:
 * инструменты клиенту объявить нельзя (`no-client-tools`, справочник §6),
 * подписанный блок размышлений мост воспроизвести не может, а полей вроде
 * `top_k` в диалекте OpenAI просто нет.
 */
export const DIALECT_TABLE: DialectRow[] = [
  { anthropic: 'model', openai: 'model', fate: 'mapped', note: 'имя модели идёт как есть' },
  {
    anthropic: 'messages',
    openai: 'messages',
    fate: 'lossy',
    note: 'реплики переносятся; блоки содержимого разворачиваются в текст и картинки',
  },
  {
    anthropic: 'system',
    openai: 'messages[0].role=system',
    fate: 'renamed',
    note: 'системная строка становится первой репликой с ролью system',
  },
  {
    anthropic: 'system[] (массив блоков)',
    openai: 'messages[0].role=system',
    fate: 'lossy',
    note: 'текст блоков склеивается; разметка блоков и пометки кэша теряются',
  },
  { anthropic: 'max_tokens', openai: 'max_tokens', fate: 'mapped', note: 'потолок ответа' },
  { anthropic: 'temperature', openai: 'temperature', fate: 'mapped', note: '' },
  { anthropic: 'top_p', openai: 'top_p', fate: 'mapped', note: '' },
  {
    anthropic: 'top_k',
    openai: '',
    fate: 'dropped',
    note: 'в диалекте OpenAI такого параметра нет — придумывать замену мост не станет',
  },
  {
    anthropic: 'stop_sequences',
    openai: 'stop',
    fate: 'renamed',
    note: 'список стоп-строк',
  },
  { anthropic: 'stream', openai: 'stream', fate: 'mapped', note: '' },
  {
    anthropic: 'metadata.user_id',
    openai: 'user',
    fate: 'lossy',
    note: 'контур принимает поле схемой и до модели не доносит (справочник §5)',
  },
  {
    anthropic: 'tools',
    openai: '',
    fate: 'dropped',
    note: 'свои инструменты контуру объявить нельзя: он подбирает их сам (`no-client-tools`)',
    withShim: {
      fate: 'shimmed',
      note: 'схемы уезжают текстом в системную строку, вызов собирается обратно из ответа модели',
    },
    native: {
      fate: 'renamed',
      note: 'схема инструмента клиента становится `tools[].function`; серверный инструмент вендора не переносится и назван отдельно',
    },
  },
  {
    anthropic: 'tool_choice',
    openai: '',
    fate: 'dropped',
    note: 'выбирать не из чего: набор инструментов не наш',
    withShim: {
      fate: 'shimmed',
      note: 'поле снимается; платформа со своими инструментами получает то, чем они гасятся (`shimRequestFields` драйвера), и работает протокол прослойки',
    },
    native: {
      fate: 'renamed',
      note: 'auto → auto, any → required, tool → function по имени, none → none; `disable_parallel_tool_use` → `parallel_tool_calls: false`',
    },
  },
  {
    anthropic: 'thinking',
    openai: '',
    fate: 'dropped',
    note: 'подписанный блок размышлений мост воспроизвести не может — подпись стала бы недействительной',
  },
  {
    anthropic: 'cache_control',
    openai: '',
    fate: 'dropped',
    note: 'кэш промпта — свойство вендорного API, у контура его нет',
  },
  {
    anthropic: 'content[].image',
    openai: 'content[].image_url',
    fate: 'renamed',
    note: 'картинка переносится data-адресом; поймёт ли её модель, зависит от самой модели',
  },
  {
    anthropic: 'content[].document',
    openai: '',
    fate: 'dropped',
    note: 'документов и цитат в диалекте контура нет',
  },
  {
    anthropic: 'content[].tool_use / tool_result',
    openai: '',
    fate: 'dropped',
    note: 'следы вызова инструментов уходят вместе с инструментами; пустая реплика не отправляется',
    withShim: {
      fate: 'shimmed',
      note: 'вызов и его результат сворачиваются в текст того же протокола — история хода остаётся целой',
    },
    native: {
      fate: 'renamed',
      note: 'вызов становится `tool_calls` реплики ассистента, результат — репликой с ролью `tool`',
    },
  },
  {
    // Строка живёт только там, где следы вызовов переносятся: без этого результат
    // не переносится целиком строкой выше, и терять внутри него нечего.
    anthropic: 'content[].tool_result (внутри картинка)',
    openai: 'messages[].content (только текст)',
    fate: 'lossy',
    note: 'картинку внутри результата инструмента не переносят ни текст прослойки, ни роль `tool` диалекта OpenAI — обе несут только текст',
  },
  {
    anthropic: 'content[].text ← choices[].message.content',
    openai: 'choices[].message.content',
    fate: 'mapped',
    note: 'ответ разворачивается обратно в блок текста',
  },
  {
    anthropic: 'stop_reason ← finish_reason',
    openai: 'choices[].finish_reason',
    fate: 'renamed',
    note: 'stop → end_turn, length → max_tokens, tool_calls → tool_use',
  },
  {
    anthropic: 'usage.input_tokens ← usage.prompt_tokens',
    openai: 'usage.prompt_tokens',
    fate: 'renamed',
    note: 'расход переименовывается; прочитанное из кэша вычитается — у Anthropic вход его не включает',
  },
  {
    anthropic: 'usage.cache_read_input_tokens ← usage.prompt_tokens_details.cached_tokens',
    openai: 'usage.prompt_tokens_details.cached_tokens',
    fate: 'renamed',
    note: 'есть только когда апстрим его прислал; сам контур кэш не считает и списывает весь вход',
  },
];

/**
 * Потери запроса в диалекте OpenAI: называются только РЕАЛЬНО присланные поля.
 *
 * ЧТО теряется — свойство платформы, а не моста: у произвольного совместимого
 * шлюза `seed` и `response_format` работают по-настоящему, и назвать их
 * потерей значило бы соврать про чужой шлюз. Поэтому список приходит манифестом
 * драйвера; пусто — потерь не объявлено.
 *
 * `tool_choice: "none"` потерей не считается — это единственное его значение,
 * которое у контура работает (выключает инструменты платформы).
 */
export function openAiRequestLoss(
  body: Record<string, unknown>,
  fields: readonly DriverRequestField[],
): DialectLoss[] {
  // `lossy` попадает в след наравне с `dropped`: «доехало наполовину» человек
  // должен видеть там же, где «не доехало вовсе», — иначе объявленная частичная
  // потеря не видна нигде и отличается от невыполненного обещания только словом
  // в манифесте.
  const dropped = fields.filter(
    (row) => row.dialect === 'openai' && (row.fate === 'dropped' || row.fate === 'lossy'),
  );
  const lost = dropped
    .filter((row) => row.field !== 'tool_choice' && body[row.field] !== undefined)
    .map((row) => ({ field: row.field, note: row.note }));

  const toolChoice = dropped.find((row) => row.field === 'tool_choice');
  if (toolChoice && body.tool_choice !== undefined && body.tool_choice !== 'none') {
    lost.push({ field: 'tool_choice', note: toolChoice.note });
  }
  return lost;
}

/** Причина остановки: значения диалектов не совпадают ни одним. */
const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

/** Одна потеря перевода: что именно не доехало и почему. */
export interface DialectLoss {
  field: string;
  note: string;
}

export interface TranslatedRequest {
  body: Record<string, unknown>;
  /** Что не перенеслось — по одной записи на РЕАЛЬНО встреченное поле. */
  lost: DialectLoss[];
  /**
   * Что перенесла прослойка (Т5): те же имена полей, но с другой судьбой.
   * Отдельный список, а не строка в `lost`: «доехало текстом» и «не доехало» —
   * разные новости, и смешать их значит либо напугать человека там, где всё
   * работает, либо успокоить там, где агент без рук.
   */
  shimmed: string[];
  /** Инструменты, объявленные клиентом: их именами проверяется ответ модели. */
  tools: ShimTool[];
}

/**
 * Как инструменты клиента едут наверх на этом запросе. Решает конвейер —
 * тумблером прослойки и манифестом драйвера; нет маршрута — инструменты
 * теряются и названы потерей.
 */
export type ToolRoute =
  /** Текстом протокола (Т5). */
  | {
      mode: 'shim';
      /** Текст протокола из каталога промптов (Т4). Здесь его копии нет и не будет. */
      protocolText: string;
      /** Чем гасятся инструменты самой платформы (`driver.shimRequestFields`). */
      requestFields?: Readonly<Record<string, unknown>>;
    }
  /**
   * Полем `tools` диалекта OpenAI: платформа его принимает — `clientTools`
   * `native` или `native-no-call`. Зовёт ли по нему модель, маршрут не решает:
   * это вопрос модели, и отвечает на него проба при активации.
   */
  | { mode: 'native' };

/**
 * Маршрут инструментов — одно решение на конвейер и на проверку драйверов.
 *
 * Порядок — от сильного к слабому:
 * - инструменты САМОЙ платформы (Т7) — два набора на один ход взаимно
 *   исключаются, и клиентские теряются, названные потерей;
 * - тумблер прослойки — выбор человека: шлюз без разборщика вызовов у модели
 *   принимает `tools` схемой и молча не зовёт ничего, и лечится это только им;
 * - манифест драйвера: платформа, принимающая `tools` полем, получает их полем.
 *
 * `native-no-call` идёт тем же маршрутом, что и `native`: поле платформа
 * принимает, и выбрасывать его здесь значило бы объявить потерей то, что
 * доезжает. Своё оно говорит умолчанием прослойки и словами на карточке, а не
 * подменой маршрута — иначе модель, начавшая звать (сменили её или шлюз
 * дообучили), не смогла бы это показать никогда.
 *
 * Текст протокола читается только там, где он нужен: это файл каталога.
 */
export function chooseToolRoute(
  platform: { toolShim: boolean; platformTools: boolean },
  driver: {
    clientTools: PlatformClientTools;
    shimRequestFields?: Readonly<Record<string, unknown>>;
  },
  protocolText: () => string,
): ToolRoute | undefined {
  if (platform.platformTools) return undefined;
  if (platform.toolShim) {
    return {
      mode: 'shim',
      protocolText: protocolText(),
      ...(driver.shimRequestFields ? { requestFields: driver.shimRequestFields } : {}),
    };
  }
  return clientToolsTravel(driver.clientTools) ? { mode: 'native' } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Строка таблицы по имени поля Anthropic — чтобы текст потери был один.
 * Драйвер уточняет её своей: одно и то же поле у разных платформ теряется по
 * разным причинам, и общая формулировка тогда врёт про одну из них.
 */
function rowNote(anthropic: string, fields: readonly DriverRequestField[] = []): string {
  const override = fields.find(
    // Уточнять можно только ПОТЕРЮ. Строка манифеста, объявившая поле
    // перенесённым там, где мост его не переносит, иначе подписывала бы потерю
    // текстом «контур это принимает» — то есть объясняла бы пропажу её
    // отсутствием.
    (row) =>
      row.dialect === 'anthropic' &&
      row.field === anthropic &&
      (row.fate === 'dropped' || row.fate === 'lossy'),
  );
  if (override) return override.note;
  return DIALECT_TABLE.find((row) => row.anthropic === anthropic)?.note ?? '';
}

function lose(lost: DialectLoss[], field: string, fields?: readonly DriverRequestField[]): void {
  if (lost.some((item) => item.field === field)) return;
  lost.push({ field, note: rowNote(field, fields) });
}

/** Часть содержимого в форме OpenAI: текст либо картинка. */
type OpenAiPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * Блоки Anthropic → части OpenAI. Возвращает пусто, если переносить нечего:
 * реплика из одних следов инструментов не отправляется вовсе, потому что
 * контур требует непустое содержимое у всех ролей, кроме assistant.
 */
function blocksToParts(
  content: unknown,
  lost: DialectLoss[],
  fold?: FoldTraces,
  native?: NativeTraces,
): OpenAiPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: OpenAiPart[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push({ type: 'text', text: block });
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.cache_control !== undefined) lose(lost, 'cache_control');

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && isRecord(block.source)) {
      const url = imageUrl(block.source);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    if (block.type === 'document') {
      lose(lost, 'content[].document');
      continue;
    }
    if (block.type === 'tool_use' || block.type === 'tool_result') {
      // Платформа принимает вызовы полем — след уходит в своей упаковке, а не
      // частью текста: реплику собирает вызывающий.
      if (native) {
        collectNativeTrace(block, native);
        continue;
      }
      // Прослойка выключена — след вызова уходит вместе с инструментами.
      if (!fold) {
        lose(lost, 'content[].tool_use / tool_result');
        continue;
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        parts.push({ type: 'text', text: encodeToolUse(block.name, block.input) });
        fold.shimmed();
        continue;
      }
      const result = encodeToolResult(block, fold.names);
      if (result.dropped) lose(lost, 'content[].tool_result (внутри картинка)');
      parts.push({ type: 'text', text: result.text });
      fold.shimmed();
      continue;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      lose(lost, 'thinking');
      continue;
    }
  }
  return parts;
}

/** Картинка Anthropic приезжает base64 либо ссылкой; наружу — data-адрес. */
function imageUrl(source: Record<string, unknown>): string {
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  if (typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return `data:${media};base64,${source.data}`;
  }
  return '';
}

/**
 * Части → содержимое реплики. Один текст остаётся строкой: массив из одной
 * текстовой части понимают не все совместимые шлюзы, а строку — все.
 */
function partsToContent(parts: OpenAiPart[]): string | OpenAiPart[] | undefined {
  if (parts.length === 0) return undefined;
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n');
  }
  return parts;
}

/**
 * Запрос Anthropic → запрос контура.
 *
 * Всё, что таблица помечает `dropped`, сюда не попадает НИКОГДА: лишний ключ
 * контур молча выбросит своей схемой (`extra='ignore'`), и разница между
 * «мы не послали» и «оно исчезло по дороге» стала бы невидимой.
 */
export function anthropicRequestToOpenAi(
  input: unknown,
  fields: readonly DriverRequestField[],
  route?: ToolRoute,
): TranslatedRequest {
  const lost: DialectLoss[] = [];
  const shimmed: string[] = [];
  if (!isRecord(input)) return { body: {}, lost, shimmed, tools: [] };

  const shim = route?.mode === 'shim' ? route : undefined;
  const native = route?.mode === 'native';
  const tools = shim ? readTools(input.tools) : [];
  // Свернуть следы вызовов можно только вместе с самими инструментами: без
  // списка модель прочтёт `<tool_call>` прошлого хода как форму, которой её
  // никто не учил, и повторит её наугад.
  const fold: FoldTraces | undefined =
    shim && tools.length > 0
      ? {
          names: toolNamesById(input.messages),
          shimmed: () => noteShimmed(shimmed, 'content[].tool_use / tool_result'),
        }
      : undefined;

  const body: Record<string, unknown> = {};
  if (typeof input.model === 'string') body.model = input.model;

  const messages: Record<string, unknown>[] = [];
  const addendum = shim ? systemAddendum(shim.protocolText, tools) : '';

  if (input.system !== undefined || addendum) {
    if (Array.isArray(input.system)) lose(lost, 'system[] (массив блоков)');
    const parts = blocksToParts(input.system, lost);
    // Правила протокола дописываются ПОСЛЕ системной строки клиента: последнее
    // в системном сообщении модель держит ближе всего к делу, а спорить с
    // промптом CLI прослойке нечем — он длиннее её в сотню раз.
    if (addendum) parts.push({ type: 'text', text: addendum });
    const content = partsToContent(parts);
    if (content !== undefined) messages.push({ role: 'system', content });
  }

  if (Array.isArray(input.messages)) {
    for (const message of input.messages) {
      if (!isRecord(message)) continue;
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const traces = native ? emptyTraces() : undefined;
      const content = partsToContent(blocksToParts(message.content, lost, fold, traces));
      if (traces) {
        if (traces.droppedResultParts) lose(lost, 'content[].tool_result (внутри картинка)');
        // Результаты — ПЕРЕД остальным текстом реплики: роль `tool` обязана идти
        // сразу за репликой с вызовами, иначе строгий шлюз отвергает историю.
        messages.push(...traces.results);
        if (role === 'assistant' && traces.calls.length > 0) {
          // Реплика из одних вызовов законна: содержимое `null`, вызовы рядом.
          messages.push({ role, content: content ?? null, tool_calls: traces.calls });
          continue;
        }
      }
      // Реплика, от которой после перевода ничего не осталось, не отправляется:
      // контур отвергает пустое содержимое у всех ролей, кроме assistant.
      if (content === undefined) continue;
      messages.push({ role, content });
    }
  }
  body.messages = messages;

  if (typeof input.max_tokens === 'number') body.max_tokens = input.max_tokens;
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  if (typeof input.top_p === 'number') body.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences)) body.stop = input.stop_sequences;
  if (typeof input.stream === 'boolean') body.stream = input.stream;
  if (isRecord(input.metadata) && typeof input.metadata.user_id === 'string') {
    body.user = input.metadata.user_id;
    lose(lost, 'metadata.user_id');
  }

  // `top_k` и `thinking` — потери САМОГО перевода: первого в диалекте OpenAI
  // нет вовсе, второе не воспроизводится без подписи. Это верно у любой
  // платформы, поэтому решает таблица.
  if (input.top_k !== undefined) lose(lost, 'top_k', fields);
  if (input.thinking !== undefined) lose(lost, 'thinking', fields);

  // Инструменты уезжают полем (платформа его принимает), текстом прослойки либо
  // ТЕРЯЮТСЯ — четвёртого нет, и в след попадает ровно то, что случилось.
  //
  // Потеря безусловна там, где нет маршрута: драйвер, объявивший инструменты
  // полем, при выключенном маршруте получал бы пустой след при выброшенных
  // инструментах — панель обещала бы агенту руки и молчала о том, что их нет.
  if (native) {
    translateNativeTools(input, body, lost, fields);
  } else if (tools.length > 0) {
    noteShimmed(shimmed, 'tools');
    noteShimmed(shimmed, 'tool_choice');
    // compromise: tool-shim — контур не принимает `tools`, поэтому схемы едут текстом, а вызов собирается обратно
    Object.assign(body, shim?.requestFields);
  } else {
    if (input.tools !== undefined) lose(lost, 'tools', fields);
    if (input.tool_choice !== undefined) lose(lost, 'tool_choice', fields);
  }

  return { body: renameRequestFields(body, fields), lost, shimmed, tools };
}

/**
 * Схемы и выбор инструмента — полями диалекта OpenAI.
 *
 * `tool_choice` без `tools` не отправляется никогда: строгий шлюз отвергает
 * такой запрос целиком, и агент, у которого все инструменты оказались
 * серверными, получил бы 400 вместо ответа без рук.
 */
function translateNativeTools(
  input: Record<string, unknown>,
  body: Record<string, unknown>,
  lost: DialectLoss[],
  fields: readonly DriverRequestField[],
): void {
  const list = nativeToolList(input.tools);
  if (list.cached) lose(lost, 'cache_control');
  if (list.skipped && !lost.some((item) => item.field === SERVER_TOOL_LOSS.field)) {
    lost.push({ ...SERVER_TOOL_LOSS });
  }
  if (list.tools.length === 0) {
    if (input.tool_choice !== undefined) lose(lost, 'tool_choice', fields);
    return;
  }
  body.tools = list.tools;
  if (input.tool_choice === undefined) return;
  const choice = nativeToolChoice(input.tool_choice);
  if (choice.value === undefined) {
    lose(lost, 'tool_choice', fields);
    return;
  }
  body.tool_choice = choice.value;
  if (choice.parallel === false) body.parallel_tool_calls = false;
}

/** Что нужно свёртке следов: имена вызовов и куда записать, что она сработала. */
interface FoldTraces {
  names: ReadonlyMap<string, string>;
  shimmed: () => void;
}

/**
 * Переименованные поля манифеста (`fate: 'renamed'`) — ПОСЛЕДНИЙ шаг сборки
 * тела, на копии: поля моста и прослойки собираются под общими именами, и
 * переименовать их раньше значило бы разминуться с ними.
 *
 * Имя назначения, которое клиент прислал сам, побеждает: он знает, что просит,
 * а старое имя рядом с ним — дубль, который строгий шлюз отверг бы целиком.
 */
export function renameRequestFields(
  body: Record<string, unknown>,
  fields: readonly DriverRequestField[],
): Record<string, unknown> {
  const renames = fields.filter((row) => row.fate === 'renamed' && row.dialect === 'openai');
  if (!renames.some((row) => body[row.field] !== undefined)) return body;
  const out = { ...body };
  for (const row of renames) {
    if (row.fate !== 'renamed' || out[row.field] === undefined) continue;
    if (out[row.to] === undefined) out[row.to] = out[row.field];
    delete out[row.field];
  }
  return out;
}

function noteShimmed(shimmed: string[], field: string): void {
  if (!shimmed.includes(field)) shimmed.push(field);
}

/**
 * Запрос в диалекте OpenAI. Переводить нечего — контур говорит на нём же, — но
 * при прослойке инструменты надо снять с поля и положить текстом. Без неё (и у
 * платформы, принимающей их полем) остаётся только список потерь.
 */
export function openAiRequestWithShim(
  body: Record<string, unknown>,
  fields: readonly DriverRequestField[],
  route?: ToolRoute,
): TranslatedRequest {
  const shim = route?.mode === 'shim' ? route : undefined;
  if (!shim || readTools(body.tools).length === 0) {
    return {
      body: renameRequestFields(body, fields),
      lost: openAiRequestLoss(body, fields),
      shimmed: [],
      tools: [],
    };
  }

  const shimmed = shimOpenAiRequest(body, shim.protocolText, shim.requestFields);
  const lost = openAiRequestLoss(shimmed.body, fields);
  if (shimmed.droppedResultParts) {
    lost.push({
      field: 'content[].tool_result (внутри картинка)',
      note: rowNote('content[].tool_result (внутри картинка)'),
    });
  }
  return {
    body: renameRequestFields(shimmed.body, fields),
    lost,
    shimmed: ['tools', 'tool_choice'],
    tools: shimmed.tools,
  };
}

/**
 * Причина остановки в диалекте Anthropic — по причине контура И по числу блоков
 * `tool_use`, которые клиент действительно получил.
 *
 * Вызов перебивает любую причину: клиент, прочитавший «ход закончен» рядом с
 * вызовом, выполнит его и не пришлёт результат. И обратно: `tool_use` без единого
 * блока — невалидное сообщение, клиент ждёт вызов, которого нет, и ход повисает.
 * Причину «вызов» контур вправе назвать и тогда, когда собрать вызов не вышло.
 */
export function stopReasonOf(finishReason: unknown, calls: number): string {
  if (calls > 0) return 'tool_use';
  const reason =
    typeof finishReason === 'string' ? (STOP_REASON[finishReason] ?? 'end_turn') : 'end_turn';
  return reason === 'tool_use' ? 'end_turn' : reason;
}

/**
 * Цельный ответ контура → цельный ответ Anthropic. Идентификатор берётся
 * контуровский с приставкой: клиенты по нему ничего не ищут, а в журнале двух
 * сторон один и тот же вызов должно быть видно как один.
 */
/**
 * Id сообщения Anthropic, которое шлюз выдаёт клиенту: id контура с приставкой
 * (тот же вызов виден в журналах обеих сторон как один) и суффиксом запроса.
 * Суффикс нужен потому, что id контура не обязан быть уникальным — а Claude Code
 * пишет этот id в транскрипт, и по нему лента находит ответ, где контур сжал
 * историю: одинаковый id у двух ответов подписал бы оба.
 */
export function anthropicMessageId(upstreamId: unknown, suffix = ''): string {
  const base = typeof upstreamId === 'string' && upstreamId ? upstreamId : Date.now().toString(36);
  return suffix ? `msg_${base}-${suffix}` : `msg_${base}`;
}

export function openAiResponseToAnthropic(payload: unknown, model: string, idSuffix = ''): unknown {
  const source = isRecord(payload) ? payload : {};
  const choice = Array.isArray(source.choices) ? source.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const usage = isRecord(source.usage) ? source.usage : {};
  const text = typeof message.content === 'string' ? message.content : '';

  // Вызовы прослойки — отдельными блоками ПОСЛЕ текста, ровно в том порядке, в
  // каком их написала модель: клиент выполняет их сверху вниз.
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
  const content: Record<string, unknown>[] = [];
  if (text || calls.length === 0) content.push({ type: 'text', text });
  for (const call of calls) {
    const fn = isRecord(call.function) ? call.function : {};
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      input: parseArguments(fn.arguments),
    });
  }

  return {
    id: anthropicMessageId(source.id, idSuffix),
    type: 'message',
    role: 'assistant',
    model: typeof source.model === 'string' ? source.model : model,
    content,
    stop_reason: stopReasonOf(isRecord(choice) ? choice.finish_reason : undefined, calls.length),
    stop_sequence: null,
    usage: anthropicUsage(
      numberOf(usage.prompt_tokens),
      numberOf(usage.completion_tokens),
      cachedTokensOf(usage),
    ),
  };
}

/**
 * Сколько входа модель прочла из кэша. Контур тело модели не переписывает, и
 * OpenAI-совместимый апстрим (OpenAI, vLLM) кладёт это в `prompt_tokens_details`.
 */
export function cachedTokensOf(usage: unknown): number {
  const details =
    isRecord(usage) && isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return numberOf(details.cached_tokens);
}

/**
 * Расход в форме Anthropic. Там `input_tokens` кэша НЕ включает, а у OpenAI
 * `prompt_tokens` — включает: перенос одним числом записывал в транскрипт CLI
 * весь вход свежим, и прочитанное из кэша исчезало из учёта.
 */
export function anthropicUsage(
  prompt: number,
  completion: number,
  cached: number,
): Record<string, number> {
  const read = Math.min(cached, prompt);
  return {
    input_tokens: prompt - read,
    ...(read > 0 ? { cache_read_input_tokens: read } : {}),
    output_tokens: completion,
  };
}

/** Расход в форме OpenAI; кэш — только когда он был, как отдаёт сам OpenAI. */
export function openAiUsage(
  prompt: number,
  completion: number,
  total: number,
  cached: number,
): Record<string, unknown> {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/**
 * Список моделей контура → форма Anthropic. Клиент, спросивший на маршруте
 * `/v1/messages`, разбирает ответ своей схемой, и список в чужой форме он
 * читает как «моделей нет» — то есть как пустой выпадающий список вместо
 * настроенного контура.
 */
export function openAiModelsToAnthropic(payload: unknown): unknown {
  const source = isRecord(payload) ? payload : {};
  const list = Array.isArray(source.data) ? source.data : [];

  return {
    data: list.filter(isRecord).map((item) => {
      const id = typeof item.id === 'string' ? item.id : '';
      return {
        type: 'model',
        id,
        // Своего человеческого имени у контура нет — показываем
        // идентификатор, а не выдумываем название.
        display_name: id,
        ...(typeof item.created === 'number'
          ? { created_at: new Date(item.created * 1_000).toISOString() }
          : {}),
      };
    }),
    has_more: false,
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Аргументы вызова в диалекте OpenAI — строка JSON; у Anthropic — объект. */
function parseArguments(value: unknown): unknown {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Сюда попадает только то, что прослойка уже разобрала и сериализовала
    // сама, — но чужой ответ ходит этим же путём, и пустой объект честнее
    // выдуманных аргументов.
    return {};
  }
}

/**
 * Отказ в форме диалекта клиента.
 *
 * Форма важнее текста: CLI разбирает ошибку по своей схеме, и понятная причина
 * доходит до человека, а не превращается в «unexpected response». Текст при
 * этом остаётся русским — контур присылает его по-русски и уже без секретов
 * (справочник §8), пересказывать его мост не берётся.
 */
export function errorBody(
  dialect: Dialect,
  message: string,
  code: string,
  language: TextLanguage = 'ru',
): unknown {
  // Тело отказа читает CLI и печатает как есть — переводчика между ними нет,
  // поэтому язык панели подставляется здесь (`lib/server-texts.ts`).
  const said = localizeText(message, language);
  return dialect === 'anthropic'
    ? { type: 'error', error: { type: anthropicErrorType(code), message: said } }
    : { error: { message: said, type: openAiErrorType(code), code } };
}

function anthropicErrorType(code: string): string {
  if (code === 'authentication_error') return 'authentication_error';
  if (code === 'permission_error') return 'permission_error';
  if (code === 'not_found_error') return 'not_found_error';
  if (code === 'rate_limit_error') return 'rate_limit_error';
  if (code === 'request_too_large') return 'request_too_large';
  if (code === 'billing_error') return 'billing_error';
  if (code === 'api_error' || code === 'overloaded_error') return code;
  return 'invalid_request_error';
}

/**
 * Тип ошибки в диалекте OpenAI. Раньше здесь для любого отказа стояло
 * `invalid_request_error`, и лимит частоты или сбой контура клиент читал как
 * «исправьте запрос» — повторять такой запрос он не станет, а чинить в нём нечего.
 */
function openAiErrorType(code: string): string {
  if (code === 'authentication_error' || code === 'permission_error') return code;
  if (code === 'not_found_error' || code === 'rate_limit_error') return code;
  if (code === 'billing_error') return 'insufficient_quota';
  if (code === 'api_error' || code === 'overloaded_error') return 'server_error';
  return 'invalid_request_error';
}

/**
 * Ошибка, пришедшая ВНУТРИ потока (`data: {"error": {...}}`), — к коду моста.
 *
 * Общая часть, а не строка драйвера: конверт `{error: {message, type, code}}`
 * один у OpenAI, у LiteLLM, у OpenRouter и у платформы компании, различаются только
 * значения. Порядок проверок — от узкого к широкому: у платформы компании `type` выведен из
 * HTTP-статуса, и отказ проверок содержимого там `invalid_request_error`, а
 * отличает его только `code`; у OpenRouter `code` — это сам статус числом.
 */
export function upstreamErrorCode(error: Record<string, unknown>): string {
  const code = error.code;
  if (typeof code === 'string') {
    const word = code.toLowerCase();
    if (word.includes('content_policy') || word.includes('content_filter')) {
      return 'content_policy_violation';
    }
    if (word.includes('rate_limit')) return 'rate_limit_error';
    if (word.includes('quota') || word.includes('budget')) return 'billing_error';
    if (word.includes('context_length') || word === 'bad_request') return 'invalid_request_error';
    if (word === 'unknown_model' || word === 'wrong_model_kind') return 'invalid_request_error';
    if (word === 'registry_not_loaded' || word.includes('overloaded')) return 'overloaded_error';
    if (word === 'timeout' || word.includes('upstream') || word.includes('internal')) {
      return 'api_error';
    }
  }
  const status = typeof code === 'number' ? code : Number.NaN;
  if (Number.isFinite(status)) {
    if (status === 401) return 'authentication_error';
    if (status === 402) return 'billing_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 413) return 'request_too_large';
    if (status === 429) return 'rate_limit_error';
    if (status === 503 || status === 529) return 'overloaded_error';
    if (status >= 500) return 'api_error';
    if (status >= 400) return 'invalid_request_error';
  }
  const type = typeof error.type === 'string' ? error.type : '';
  if (type === 'server_error') return 'api_error';
  if (type === 'insufficient_quota') return 'billing_error';
  if (
    [
      'authentication_error',
      'permission_error',
      'not_found_error',
      'rate_limit_error',
      'overloaded_error',
      'billing_error',
      'api_error',
      'invalid_request_error',
      'request_too_large',
    ].includes(type)
  ) {
    return type;
  }
  // Ни кода, ни типа — значит это сбой той стороны, а не ошибка запроса: отправить
  // человека «исправлять запрос», в котором нечего исправлять, хуже, чем повтор.
  return 'api_error';
}

/**
 * HTTP-статус для кода моста: цельному телу и следу запроса. Клиенты ветвят
 * повтор по статусу, а не по тексту, — 502 на лимит частоты значил бы немедленный
 * повтор туда, где ждать надо минуту.
 */
export function statusOfErrorCode(code: string): number {
  const statuses: Record<string, number> = {
    authentication_error: 401,
    billing_error: 402,
    permission_error: 403,
    not_found_error: 404,
    request_too_large: 413,
    rate_limit_error: 429,
    overloaded_error: 503,
    api_error: 502,
  };
  return statuses[code] ?? 400;
}
