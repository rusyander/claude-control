import type { PlatformCapabilityFinding } from '@agentdeck/contracts';
import type { CompromiseId } from '@agentdeck/contracts/compromises';
import {
  readPlatformModels,
  versionedUrl,
  type DriverReading,
  type PlatformDriver,
} from './driver.ts';

/**
 * Драйвер корпоративной платформы: публичная поверхность по ключу.
 *
 * Что он знает и откуда:
 * - список моделей УЖЕ сужен правами ключа — это единственный бесплатный
 *   источник правды о том, что ключу доступно;
 * - вид модели (чат/эмбеддинги) берётся из объявленного платформой поля, а НЕ
 *   из имени модели: «угадать по подстроке embed» — ровно то враньё, ради
 *   которого заведён инвариант 13;
 * - проверки контента работают в полосе запроса — свойство самой платформы, а
 *   не ключа: блокировка приезжает статусом 451 вместе с ответом;
 * - агенты бесплатно не проверяются: узнать про них можно только вызовом
 *   опубликованного агента, а тратить деньги ключа молча панель не станет.
 *   Поэтому «не объявлено», а не галка.
 */

/**
 * Текст 401 живёт ОДНОЙ строкой: его говорит и шлюз, и кнопка «Проверить
 * связь». Две копии разошлись бы на первой же правке, и человек получал бы
 * разный совет от двух кнопок про один и тот же отказ.
 *
 * Здесь, а не в шлюзе, потому что это знание о ПЛАТФОРМА КОМПАНИИ, проверенное в её
 * исходниках: у произвольного совместимого шлюза пяти причин нет, и
 * подставлять их ему значило бы утверждать непроверенное.
 */
export const KEY_REJECTED_DETAIL =
  'Контур отклонил ключ, и причину он не называет. Их пять: ключ неизвестен или отозван, ' +
  'истёк по сроку, исчерпал свой бюджет, его владельца удалили — либо сверка владельца на ' +
  'стороне контура не удалась (тогда ключ в порядке, и стоит повторить). Проверьте ключ, ' +
  'его срок, бюджет и владельца в админке платформы';

/**
 * Строка матрицы. `evidence` обязателен и не имеет умолчания намеренно: это
 * граница между «панель увидела это в ответе ВАШЕГО контура» и «так устроена
 * платформа вообще», и молча выбранная сторона была бы ровно тем враньём, от
 * которого заведён инвариант 13.
 */
function capability(
  id: PlatformCapabilityFinding['id'],
  state: PlatformCapabilityFinding['state'],
  evidence: PlatformCapabilityFinding['evidence'],
  detail: string,
  extra: { compromise?: CompromiseId; count?: number } = {},
): PlatformCapabilityFinding {
  return { id, state, detail, evidence, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Карта подмены из кадра: только пары «строка → строка».
 *
 * Кадр приходит от чужой стороны, и вложенный объект или число в значении
 * здесь не ошибка формата, а причина НЕ подставлять: замена текста на `[object
 * Object]` внутри аргумента вызова хуже неразвёрнутой метки — её хотя бы видно.
 */
function readMapping(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const map: Record<string, string> = {};
  for (const [alias, original] of Object.entries(value)) {
    if (typeof original === 'string' && alias) map[alias] = original;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export const enterprise-platformDriver: PlatformDriver = {
  id: 'enterprise-platform',
  title: 'Контур',

  modelsUrl: (baseUrl) => versionedUrl(baseUrl, 'models'),

  headers: (token) => ({
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }),

  read(payload): DriverReading {
    const models = readPlatformModels(payload);
    // Вид модели объявляет платформа полем, а не именем модели: молчание в этом
    // поле остаётся молчанием и ниже превращается в «не объявлено».
    //
    // Считаем только РАСПОЗНАННЫЕ виды. Поле вида ищется по нескольким именам,
    // и среди них есть общие (`type`, `mode`): у части шлюзов там лежит совсем
    // другое — `{"id":"gpt-4o","type":"model"}`. Считать такую строку
    // объявлением значило бы объявить от имени контура «моделей чата ключу не
    // выдано» — тот же инвариант 13, только вывернутый в отказ, а отказ на
    // экране страшнее молчания: человек пойдёт чинить права ключа.
    const kinds = models.map((model) => model.kind).filter((kind): kind is string => Boolean(kind));
    const embeddingCount = kinds.filter((kind) => kind.includes('embed')).length;
    const chatCount = kinds.filter((kind) => kind.includes('chat') || kind.includes('text')).length;
    const declared = embeddingCount + chatCount;

    const capabilities: PlatformCapabilityFinding[] = [
      capability('models', 'yes', 'answer', 'список сужен правами ключа', { count: models.length }),

      // Вид модели объявляет сама платформа. Список без объявленных видов —
      // это «не объявлено», а не «чата нет»: панель не решает за платформу.
      declared === 0
        ? capability(
            'chat',
            models.length > 0 ? 'unknown' : 'no',
            'answer',
            'вид моделей не объявлен',
          )
        : capability(
            'chat',
            chatCount > 0 ? 'yes' : 'no',
            'answer',
            chatCount > 0 ? 'модели чата в списке ключа' : 'моделей чата ключу не выдано',
            { count: chatCount },
          ),

      declared === 0
        ? capability('embeddings', 'unknown', 'answer', 'вид моделей не объявлен')
        : capability(
            'embeddings',
            embeddingCount > 0 ? 'yes' : 'no',
            'answer',
            embeddingCount > 0
              ? 'модели эмбеддингов в списке ключа'
              : 'моделей эмбеддингов ключу не выдано',
            { count: embeddingCount },
          ),

      // Проверить агентов можно только вызовом опубликованного агента: это
      // деньги ключа, и тратить их ради галки в матрице панель не станет.
      capability(
        'agents',
        'unknown',
        'answer',
        'проверяется только вызовом агента — панель его не делает',
      ),

      // Свойство самой платформы, а не ключа: проверки идут в полосе запроса, и
      // блокировка приезжает вместе с ответом, статусом 451. Ответ КОНКРЕТНОГО
      // контура этого не подтверждает — потому `platform`, а не `answer`.
      capability(
        'guardrails',
        'yes',
        'platform',
        'работают в полосе запроса: отказ приходит статусом 451',
      ),

      // compromise: kb-via-owner — знания компании доступны только косвенно, через владельца ключа
      capability(
        'knowledge',
        'indirect',
        'platform',
        'через владельца ключа, отдельного маршрута нет',
        { compromise: 'kb-via-owner' },
      ),

      // compromise: no-client-tools — публичная схема не принимает описания инструментов, список клиента отбрасывается
      capability(
        'client-tools',
        'no',
        'platform',
        'публичный API не принимает описания инструментов',
        { compromise: 'no-client-tools' },
      ),
    ];

    return {
      models,
      capabilities,
      // Известные свойства платформы, которые обязан знать шлюз: не-потоковый
      // запрос рвётся на 120 с, а длинную историю платформа сжимает сама.
      limits: { nonStreamTimeoutSec: 120, managedContext: true },
      notes: [],
      compromises: ['kb-via-owner', 'no-client-tools'],
    };
  },

  /**
   * Судьба полей у этого контура. Три строки, и все три — его собственные:
   * инструменты клиента публичная схема отбрасывает как лишний ключ, выбирать
   * из них поэтому нечего, а подписанный блок размышлений мост воспроизвести
   * не может.
   */
  requestFields: [
    {
      dialect: 'anthropic',
      field: 'tools',
      fate: 'dropped',
      note: 'свои инструменты контуру объявить нельзя: он подбирает их сам (`no-client-tools`)',
    },
    {
      dialect: 'anthropic',
      field: 'tool_choice',
      fate: 'dropped',
      note: 'выбирать не из чего: набор инструментов не наш',
    },
    {
      dialect: 'anthropic',
      field: 'thinking',
      fate: 'dropped',
      note: 'подписанный блок размышлений мост воспроизвести не может — подпись стала бы недействительной',
    },

    // Поля диалекта OpenAI, которые публичная схема контура ПРИНИМАЕТ и до
    // модели не доносит. У произвольного совместимого шлюза половина из них
    // работает по-настоящему — поэтому список принадлежит этому драйверу, а не
    // мосту диалектов.
    {
      dialect: 'openai',
      field: 'tools',
      fate: 'dropped',
      note: 'контур игнорирует схемы инструментов молча: он подбирает инструменты сам (`no-client-tools`)',
    },
    {
      dialect: 'openai',
      field: 'tool_choice',
      fate: 'dropped',
      note: 'у контура имеет смысл только «none»: набор инструментов не наш',
    },
    {
      dialect: 'openai',
      field: 'n',
      fate: 'dropped',
      note: 'принято схемой и потеряно: контур отдаёт один вариант ответа (справочник §5)',
    },
    {
      dialect: 'openai',
      field: 'presence_penalty',
      fate: 'dropped',
      note: 'принято схемой контура и до модели не доносится',
    },
    {
      dialect: 'openai',
      field: 'frequency_penalty',
      fate: 'dropped',
      note: 'принято схемой контура и до модели не доносится',
    },
    {
      dialect: 'openai',
      field: 'user',
      fate: 'dropped',
      note: 'принято схемой контура и до модели не доносится',
    },
    {
      dialect: 'openai',
      field: 'response_format',
      fate: 'dropped',
      note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
    },
    {
      dialect: 'openai',
      field: 'seed',
      fate: 'dropped',
      note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
    },
    {
      dialect: 'openai',
      field: 'logprobs',
      fate: 'dropped',
      note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
    },
    {
      dialect: 'openai',
      field: 'logit_bias',
      fate: 'dropped',
      note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
    },
  ],

  readFrame(payload) {
    if (payload.enterprise-platform_status !== undefined) {
      return { kind: 'status', field: 'enterprise-platform_status', stage: String(payload.enterprise-platform_status) };
    }
    if (payload.enterprise-platform_reasoning !== undefined) {
      return { kind: 'reasoning', field: 'enterprise-platform_reasoning' };
    }
    if (payload.enterprise-platform_sanitized !== undefined) {
      // Перечень лежит ВНУТРИ кадра, а бывает, что и рядом с ним: форма — обещание
      // документации, живого кадра никто не видел. Читаем оба уровня, потому что
      // строгое чтение одного теряло имена молча.
      const nested = payload.enterprise-platform_sanitized;
      return {
        kind: 'sanitized',
        field: 'enterprise-platform_sanitized',
        verdict: isRecord(nested) ? nested : payload,
      };
    }
    if (payload.enterprise-platform_guardrails !== undefined) {
      const nested = payload.enterprise-platform_guardrails;
      const verdict = isRecord(nested) ? nested : payload;
      return {
        kind: 'guardrails',
        field: 'enterprise-platform_guardrails',
        verdict: Array.isArray(nested) ? { violations: nested } : verdict,
        // Флаг остановки тоже приходит на двух уровнях. Потерять его дороже
        // всего: следом идёт `[DONE]`, и оборванный ответ клиент считает целым.
        interrupted: verdict.stream_interrupted === true || payload.stream_interrupted === true,
      };
    }
    if (payload.enterprise-platform_tools_unavailable !== undefined) {
      return { kind: 'tools-dropped', field: 'enterprise-platform_tools_unavailable' };
    }
    // Обе карты подмены читаются одинаково: ключ — метка, лежащая в тексте,
    // значение — то, чем её надо заменить (`engine.go` отдаёт их этой стороной).
    // Карта нужна не для показа, а для прослойки инструментов: метка, доехавшая
    // до аргумента `Write`, окажется в файле (Р11).
    if (payload.enterprise-platform_deanonymized_entities !== undefined) {
      return {
        kind: 'anonymization',
        field: 'enterprise-platform_deanonymized_entities',
        mapping: readMapping(payload.enterprise-platform_deanonymized_entities),
      };
    }
    if (payload.enterprise-platform_anonymization_mapping !== undefined) {
      return {
        kind: 'anonymization',
        field: 'enterprise-platform_anonymization_mapping',
        mapping: readMapping(payload.enterprise-platform_anonymization_mapping),
      };
    }
    return undefined;
  },

  vendorFields: [
    'enterprise-platform_guardrails',
    'enterprise-platform_sanitized',
    'enterprise-platform_status',
    'enterprise-platform_tools_unavailable',
  ],

  statusRows: [
    // 401 значит ПЯТЬ разных вещей, и различить их снаружи нечем — причём не
    // потому, что контур их не знает, а потому, что он их теряет по дороге.
    // Тексты живут в двух местах: `inst-admin-api/.../store/keys.go`
    // `ValidateKey` отвечает «key expired» и «budget exceeded», а
    // `.../service/key_service.go` `Validate` добавляет «invalid API key»
    // (ключ неизвестен), «key owner is deleted» и «key owner check failed»
    // (сверка владельца не прошла — база не ответила). Всё это теряет
    // `inst-api/internal/auth/apikey.go`: на 401 от админки он отдаёт
    // `nil, nil`, и middleware пишет клиенту одно плоское «invalid API key».
    { upstream: 401, status: 401, code: 'authentication_error', message: KEY_REJECTED_DETAIL },
    // 402 — это НЕ бюджет ключа: контур отдаёт его с дневного лимита
    // пользователя, месячного команды или месячного инстанса.
    {
      upstream: 402,
      status: 402,
      code: 'billing_error',
      message: 'Контур отказал по лимиту расхода — до вызова модели. Это не бюджет ключа',
    },
    // 451 клиенту отдаётся кодом 400: это отказ ПО СОДЕРЖИМОМУ запроса, и
    // единственный код, который любой клиент понимает как «запрос не приняли и
    // повторять его бессмысленно».
    {
      upstream: 451,
      status: 400,
      code: 'content_policy_violation',
      message: 'Проверки контента контура остановили запрос',
      violations: true,
    },
    {
      upstream: 503,
      status: 503,
      code: 'overloaded_error',
      message: 'Контур ещё поднимается: реестр моделей не готов',
    },
  ],

  // Картинки приезжают частью обычного ответа: отдельной ручки изображений у
  // публичного API нет, рисует модель вида `image_generation`.
  images: 'chat-part',

  // compromise: no-client-tools — публичная схема отбрасывает `tools` как лишний ключ
  toolsPassthrough: false,

  /**
   * `false` значит «панель не отправляет усилие», а НЕ «контур его не умеет»:
   * в разведке публичной схемы `reasoning_effort` не встретился ни разу, но и
   * отказа в нём никто не видел. Отправить непроверенное поле — это 400 на
   * ровном месте, а объявить его компромиссом — утверждение, которого никто не
   * проверял. Живая сверка и подпись на экране — за Т6.
   */
  effort: false,

  controls: [
    {
      id: 'enterprise-platform_tools',
      title: 'Инструменты платформы',
      kind: 'request',
      detail: 'набор инструментов контура; свои объявить нельзя',
    },
    {
      id: 'tool_choice',
      title: 'Выбор инструмента платформы',
      kind: 'request',
      detail: 'по умолчанию «none» — иначе два набора инструментов спорят за один ход',
    },
    {
      id: 'generation_preset',
      title: 'Пресет генерации',
      kind: 'request',
      detail: 'именованный набор параметров на стороне контура',
    },
    {
      id: 'enable_thinking',
      title: 'Размышления модели',
      kind: 'request',
      detail: 'ответ приедет кадрами размышления, наружу они не уходят',
    },
    {
      id: 'guardrails',
      title: 'Проверки содержимого',
      kind: 'observed',
      detail: 'включает владелец контура; отказ приходит статусом 451',
    },
    {
      id: 'anonymization',
      title: 'Подмена данных',
      kind: 'observed',
      detail: 'контур переписывает найденное сам и отдаёт карту кадрами (Р11)',
    },
    {
      id: 'knowledge',
      title: 'Знания компании',
      kind: 'observed',
      detail: 'подмешиваются владельцем ключа, отдельного маршрута нет',
    },
    {
      id: 'managed-context',
      title: 'Сжатие истории',
      kind: 'observed',
      detail: 'длинную переписку контур сжимает сам — наши контрольные точки об этом не знают',
    },
  ],

  smokePrompt: 'Ответь одним словом: готов',

  /**
   * Публичный API платформы живёт на отдельном хосте, а человек чаще всего даёт
   * адрес админки, в которую сам заходит. Это знание О ПЛАТФОРМЕ, поэтому оно
   * здесь: произвольный шлюз называется как угодно, и такая подсказка на нём
   * была бы выдумкой.
   */
  addressHint(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.startsWith('api.') || host.startsWith('127.') || host === 'localhost')
        return undefined;
      return 'Похоже, это адрес админки: публичный API живёт на отдельном хосте (обычно api.<домен>).';
    } catch {
      return undefined;
    }
  },
};
