import type { PlatformCapabilityFinding } from '@agentdeck/contracts';
// Значение, а не тип: подпутём пакета, потому что сервер идёт под
// `--experimental-strip-types` и бочка `index.ts` ему не грузится вовсе.
import { platformToolModes } from '@agentdeck/contracts/platform';
import { PLATFORM_VENDOR_PREFIX } from '@agentdeck/contracts/platform-presets';
import type { CompromiseId } from '@agentdeck/contracts/compromises';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import {
  imageCapability,
  readPlatformModels,
  readSubstitutionMap,
  type DriverReading,
  type PlatformDriver,
} from './driver.ts';
import { serverText } from '../../../lib/server-texts.ts';

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
 * Здесь, а не в шлюзе, потому что это знание о ПЛАТФОРМЕ КОМПАНИИ, проверенное в её
 * исходниках: у произвольного совместимого шлюза пяти причин нет, и
 * подставлять их ему значило бы утверждать непроверенное.
 */
export const KEY_REJECTED_DETAIL = serverText('gateway-key-rejected');

/** Текст 402 — одной строкой по той же причине, что и у 401. */
export const KEY_BUDGET_DETAIL = serverText('gateway-key-budget');

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
  // Код рядом с русской причиной: английский интерфейс переводит код, а текст
  // остаётся запасным (`server-messages.ts`).
  detailCode: ServerMessageCode,
  detail: string,
  extra: { compromise?: CompromiseId; count?: number } = {},
): PlatformCapabilityFinding {
  return { id, state, detail, detailCode, evidence, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Потолок ответа сервера контура: `http.Server{WriteTimeout: 120s}` без продления
 * на потоке (так настроен его пограничный сервис). Режет ЛЮБОЙ ответ, поток тоже, —
 * поэтому одно число служит и пределом цельного ответа, и потолком потока.
 */
const PLATFORM_RESPONSE_CEILING_SEC = 120;

/**
 * Драйвер с префиксом вендорных полей. Слово в именах полей своё у каждой
 * установки платформы (`manifest.vendorPrefix`), а разбор один — поэтому
 * драйвер собирается по префиксу, а не переписывается под каждое имя.
 */
export function buildEnterprisePlatformDriver(
  prefix: string = PLATFORM_VENDOR_PREFIX,
): PlatformDriver {
  const f = (name: string): string => `${prefix}_${name}`;
  return {
    id: 'enterprise-platform',
    vendorPrefix: prefix,
    title: 'Контур',

    auth: { header: 'authorization', scheme: 'Bearer' },

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
      const kinds = models
        .map((model) => model.kind)
        .filter((kind): kind is string => Boolean(kind));
      const embeddingCount = kinds.filter((kind) => kind.includes('embed')).length;
      const chatCount = kinds.filter(
        (kind) => kind.includes('chat') || kind.includes('text'),
      ).length;
      const declared = embeddingCount + chatCount;

      const capabilities: PlatformCapabilityFinding[] = [
        capability(
          'models',
          'yes',
          'answer',
          'capability-models-key-scoped',
          'список сужен правами ключа',
          { count: models.length },
        ),

        // Вид модели объявляет сама платформа. Список без объявленных видов —
        // это «не объявлено», а не «чата нет»: панель не решает за платформу.
        declared === 0
          ? capability(
              'chat',
              models.length > 0 ? 'unknown' : 'no',
              'answer',
              'capability-kind-undeclared',
              'вид моделей не объявлен',
            )
          : capability(
              'chat',
              chatCount > 0 ? 'yes' : 'no',
              'answer',
              chatCount > 0 ? 'capability-chat-listed' : 'capability-chat-none',
              chatCount > 0 ? 'модели чата в списке ключа' : 'моделей чата ключу не выдано',
              { count: chatCount },
            ),

        declared === 0
          ? capability(
              'embeddings',
              'unknown',
              'answer',
              'capability-kind-undeclared',
              'вид моделей не объявлен',
            )
          : capability(
              'embeddings',
              embeddingCount > 0 ? 'yes' : 'no',
              'answer',
              embeddingCount > 0 ? 'capability-embeddings-listed' : 'capability-embeddings-none',
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
          'capability-agents-call-only',
          'проверяется только вызовом агента — панель его не делает',
        ),

        // Свойство самой платформы, а не ключа: проверки идут в полосе запроса, и
        // блокировка приезжает вместе с ответом, статусом 451. Ответ КОНКРЕТНОГО
        // контура этого не подтверждает — потому `platform`, а не `answer`.
        capability(
          'guardrails',
          'yes',
          'platform',
          'capability-guardrails-in-band',
          'работают в полосе запроса: отказ приходит статусом 451',
        ),

        // compromise: kb-via-owner — знания компании доступны только косвенно, через владельца ключа
        capability(
          'knowledge',
          'indirect',
          'platform',
          'capability-knowledge-via-owner',
          'через владельца ключа, отдельного маршрута нет',
          { compromise: 'kb-via-owner' },
        ),

        // compromise: no-client-tools — публичная схема не принимает описания инструментов, список клиента отбрасывается
        capability(
          'client-tools',
          'no',
          'platform',
          'capability-client-tools-rejected',
          'публичный API не принимает описания инструментов',
          { compromise: 'no-client-tools' },
        ),

        // Рисование объявляет КАТАЛОГ ключа, и ответ у строки три, а не два:
        // «модель с флагом есть», «ни одна модель флага не объявила» и «флага в
        // ответе нет вовсе». Третий случай — молчание контура, и показывать его
        // отказом нельзя: человек пойдёт просить у владельца ключа доступ,
        // которого ему, возможно, и не нужно просить.
        imageCapability(models),
      ];

      return {
        models,
        capabilities,
        // Известные свойства платформы, которые обязан знать шлюз: не-потоковый
        // запрос рвётся на 120 с, а длинную историю платформа сжимает сама.
        limits: { nonStreamTimeoutSec: PLATFORM_RESPONSE_CEILING_SEC, managedContext: true },
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
        // Усилие рассуждения (Т6). Названо здесь по той же причине, что и `n`:
        // поле уедет и исчезнет, а человек будет думать, что заплатил за глубину.
        // Своим прогонам панель `--effort` через контур не отдаёт вовсе
        // (`driver.effort = false`), но чужой CLI шлюзу его присылает сам, и без
        // этой строки потеря не видна нигде. Уйдёт в схему контура (Т12) —
        // строка удаляется вместе с переключением `effort` на `true`.
        dialect: 'openai',
        field: 'reasoning_effort',
        fate: 'dropped',
        note: 'схемой контура не объявлено: усилие рассуждения до модели не доходит (Т12)',
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
      if (payload[f('status')] !== undefined) {
        return { kind: 'status', field: f('status'), stage: String(payload[f('status')]) };
      }
      if (payload[f('reasoning')] !== undefined) {
        return { kind: 'reasoning', field: f('reasoning') };
      }
      if (payload[f('sanitized')] !== undefined) {
        // Перечень лежит ВНУТРИ кадра, а бывает, что и рядом с ним: форма — обещание
        // документации, живого кадра никто не видел. Читаем оба уровня, потому что
        // строгое чтение одного теряло имена молча.
        const nested = payload[f('sanitized')];
        return {
          kind: 'sanitized',
          field: f('sanitized'),
          verdict: isRecord(nested) ? nested : payload,
        };
      }
      if (payload[f('guardrails')] !== undefined) {
        const nested = payload[f('guardrails')];
        const verdict = isRecord(nested) ? nested : payload;
        return {
          kind: 'guardrails',
          field: f('guardrails'),
          verdict: Array.isArray(nested) ? { violations: nested } : verdict,
          // Флаг остановки тоже приходит на двух уровнях. Потерять его дороже
          // всего: следом идёт `[DONE]`, и оборванный ответ клиент считает целым.
          interrupted: verdict.stream_interrupted === true || payload.stream_interrupted === true,
        };
      }
      if (payload[f('tools_unavailable')] !== undefined) {
        return { kind: 'tools-dropped', field: f('tools_unavailable') };
      }
      // Итоговый текст ответа (его шлёт сам маршрут чата контура): проверки вывода поправили
      // текст уже после потока, либо поток разошёлся с проверенным. Клиент обязан
      // заменить им отданное — выброшенный, кадр оставлял обрезок под видом целого.
      const replaced = payload[f('deanonymized')];
      if (replaced !== undefined) {
        return {
          kind: 'replacement',
          field: f('deanonymized'),
          text: typeof replaced === 'string' ? replaced : '',
        };
      }
      // Обе карты подмены приходят ТОЛЬКО чату самой платформы: её маршрут
      // различает собственный интерфейс и чужой вызов по ключу, и клиенту API
      // значения возвращаются прямо в потоке.
      // Читаются они всё равно — ключ-метка, значение-оригинал, объектом
      // (`<префикс>_anonymization_mapping`) или списком `{placeholder, value}`
      // (`<префикс>_deanonymized_entities`): метка, доехавшая до аргумента `Write`,
      // окажется в файле (Р11).
      if (payload[f('deanonymized_entities')] !== undefined) {
        return {
          kind: 'anonymization',
          field: f('deanonymized_entities'),
          mapping: readSubstitutionMap(payload[f('deanonymized_entities')]),
        };
      }
      if (payload[f('anonymization_mapping')] !== undefined) {
        return {
          kind: 'anonymization',
          field: f('anonymization_mapping'),
          mapping: readSubstitutionMap(payload[f('anonymization_mapping')]),
        };
      }
      return undefined;
    },

    // Шаблон метки задаёт админ правила (модуль маскирования платформы, умолчание
    // `[{type}_{n}]`). Здесь — вид умолчания с любым типом; свой шаблон админа
    // этим не узнаётся, и тогда защищает только несовпадение имён.
    placeholderPattern: /\[\p{L}[\p{L}\d_]*_\d+\]/u,

    vendorFields: [f('guardrails'), f('sanitized'), f('status'), f('tools_unavailable')],

    // Нарушение в том виде, в каком его описывает модуль правил контура:
    // название правила пишет администратор, тип — перечисление. `message` не читается никогда: это текст
    // сканера, и в нём бывает найденное.
    violationNames: [
      { field: 'rule_name', label: true },
      { field: 'rule_type' },
      { field: 'scanner_name' },
    ],

    // Трёхуровневое «budget exceeded: <level>» (так его считает сам контур)
    // отдают только JWT-маршруты интерфейса — ключом туда не попасть, строки для
    // него нет.
    budgetRefusals: [{ message: /^budget exceeded for this API key$/i, scope: 'key' }],

    statusRows: [
      // 401 значит ПЯТЬ разных вещей, и различить их снаружи нечем — причём не
      // потому, что контур их не знает, а потому, что он их теряет по дороге.
      // Тексты живут в двух местах: проверка самого ключа отвечает «key
      // expired» и «budget exceeded», а слой сервиса над ней добавляет
      // «invalid API key» (ключ неизвестен), «key owner is deleted» и «key
      // owner check failed» (сверка владельца не прошла — база не ответила).
      // Всё это теряет пограничная служба контура: на 401 от админской части
      // она отдаёт пустой результат без ошибки, и клиенту уходит одно плоское
      // «invalid API key».
      { upstream: 401, status: 401, code: 'authentication_error', message: KEY_REJECTED_DETAIL },
      // На `/v1` 402 — ТОЛЬКО бюджет ключа (так отвечают обработчики публичной
      // и агентской частей контура). Окно у него узкое: результат проверки
      // ключа контур помнит 30 с, а свежая проверка на исчерпанном ключе даёт
      // уже 401.
      {
        upstream: 402,
        status: 402,
        code: 'billing_error',
        message: KEY_BUDGET_DETAIL,
      },
      // 451 клиенту отдаётся кодом 400: это отказ ПО СОДЕРЖИМОМУ запроса, и
      // единственный код, который любой клиент понимает как «запрос не приняли и
      // повторять его бессмысленно».
      {
        upstream: 451,
        status: 400,
        code: 'content_policy_violation',
        message: serverText('gateway-content-checks-request'),
        violations: true,
      },
      {
        upstream: 503,
        status: 503,
        code: 'overloaded_error',
        message: serverText('gateway-registry-not-ready'),
      },
    ],

    // Картинки приезжают частью обычного ответа: отдельной ручки изображений у
    // публичного API нет, рисует модель вида `image_generation`.
    images: 'chat-part',

    nonStreamTimeoutSec: PLATFORM_RESPONSE_CEILING_SEC,
    responseCeilingSec: PLATFORM_RESPONSE_CEILING_SEC,

    // compromise: no-client-tools — публичная схема отбрасывает `tools` как лишний ключ
    clientTools: 'shim',

    // Свои инструменты контур подбирает сам, и включённым набором перебивал бы
    // протокол прослойки: `none` — единственное значение `tool_choice`, которое у
    // него работает (Т7).
    shimRequestFields: { tool_choice: 'none' },

    /**
     * `false` значит «панель не отправляет усилие», а НЕ «контур его не умеет»:
     * в разведке публичной схемы `reasoning_effort` не встретился ни разу, но и
     * отказа в нём никто не видел. Отправить непроверенное поле — это 400 на
     * ровном месте.
     *
     * Т6 добавила к этому два следствия и НИ ОДНОГО нового утверждения о контуре:
     * прогон панели через такой контур уходит без `--effort` (решение владельца
     * 12.09.2026 — платить за глубину, которой может не быть, человек не
     * подписывался), а `reasoning_effort`, присланный чужим CLI, назван потерей в
     * следе запроса. Живой сверки по-прежнему нет: на стенде контура нет чат-модели.
     */
    // compromise: no-effort — усилие не объявлено публичной схемой контура, и панель его не отправляет (просьба добавить — Т12)
    effort: false,

    // Агенты — отдельный модуль контура за тем же ключом; списка агентов маршруты не
    // отдают (`agents-manual-roster`).
    agents: { completions: 'agent/completions', sessions: 'agent/sessions' },

    controls: [
      {
        id: f('tools'),
        title: serverText('contour-control-tools-title'),
        kind: 'request',
        field: 'platformTools',
        // Имена, а не схемы: реестр инструментов контура закрыт ключом другого
        // рода, и панели его не прочитать — список ведёт человек, как и список
        // агентов. Пустой список означает `tool_choice: "none"`: единственное
        // значение этого поля, которое публичная схема принимает всерьёз.
        //
        // Подпись эта была враньём до ревью Т7 (M2): `none` выставляла одна
        // прослойка, и только когда клиент прислал свои инструменты. В самом
        // частом случае — обычное сообщение без инструментов — наверх не уходило
        // ничего, и контур брал свои по умолчанию. Теперь выключение отправляется
        // полем `whenEmpty`, и подпись описывает провод.
        detail: serverText('contour-control-tools-detail'),
        whenEmpty: { field: 'tool_choice', value: 'none' },
      },
      {
        id: f('tool_mode'),
        title: serverText('contour-control-toolmode-title'),
        kind: 'request',
        field: 'toolMode',
        options: platformToolModes,
        // Маршрут чата контура: с потоком — 400.
        streamless: ['single_turn'],
        detail: serverText('contour-control-toolmode-detail'),
      },
      {
        id: 'generation_preset',
        title: serverText('contour-control-preset-title'),
        kind: 'request',
        field: 'generationPreset',
        detail: serverText('contour-control-preset-detail'),
      },
      {
        id: 'enable_thinking',
        title: serverText('contour-control-thinking-title'),
        kind: 'request',
        field: 'enableThinking',
        // Верхнего поля `enable_thinking` схема контура не знает и выбрасывает
        // молча (лишние ключи его схема запроса игнорирует, знает она только
        // вложенное), а до модели его доносит лишь самохостед vLLM.
        wireField: 'chat_template_kwargs.enable_thinking',
        detail: serverText('contour-control-thinking-detail'),
      },
      {
        id: 'guardrails',
        title: serverText('contour-control-guardrails-title'),
        kind: 'observed',
        where: serverText('contour-control-owner-enables'),
        detail: serverText('contour-control-guardrails-detail'),
      },
      {
        id: 'anonymization',
        title: serverText('contour-control-anonymization-title'),
        kind: 'observed',
        where: serverText('contour-control-owner-enables'),
        detail: serverText('contour-control-anonymization-detail'),
      },
      {
        id: 'knowledge',
        title: serverText('contour-control-knowledge-title'),
        kind: 'observed',
        where: serverText('contour-control-knowledge-where'),
        detail: serverText('contour-control-knowledge-detail'),
      },
      {
        id: 'managed-context',
        title: serverText('contour-control-context-title'),
        kind: 'observed',
        where: serverText('contour-control-context-where'),
        detail: serverText('contour-control-context-detail'),
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
        return serverText('contour-address-admin');
      } catch {
        return undefined;
      }
    },
  };
}

/** Драйвер с нейтральным префиксом — тот, что стоит в реестре пресетов. */
export const enterprisePlatformDriver = buildEnterprisePlatformDriver();
