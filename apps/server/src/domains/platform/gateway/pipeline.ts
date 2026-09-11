import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Platform, PlatformGatewayEvent } from '@agentdeck/contracts';
import type { AppStore } from '../../../lib/app-store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { AliasVault } from '../../dlp/mask.ts';
import { maskRequestBody } from '../../dlp/request-filter.ts';
import { ResponseStreamFilter, restoreJsonResponse } from '../../dlp/response-filter.ts';
import { readRules } from '../../dlp/rules-store.ts';
import { findPlatform, readToken } from '../store.ts';
import {
  anthropicRequestToOpenAi,
  errorBody,
  openAiModelsToAnthropic,
  openAiRequestLoss,
  openAiResponseToAnthropic,
  type Dialect,
} from './dialect.ts';
import { StreamTranslator, TRUNCATED_MESSAGE } from './frames.ts';
import { bridgeUpstreamStatus } from './status.ts';
import { callUpstream, forceStreamBody, retryAfterSeconds, UpstreamError } from './upstream.ts';
import type { SpendFlusher } from './spend-flush.ts';
import type { GatewayJournal } from './usage.ts';

/**
 * Конвейер одного запроса: распознать диалект → перевести → правила защиты
 * данных → подставить ключ → отправить → перевести ответ и поток обратно →
 * почистить вендорные кадры → записать расход.
 *
 * Чего здесь нет и не будет:
 *
 * - ЗАПАСНОГО АДРЕСА. Контур не ответил — это 502 с русской причиной, а не
 *   тихий уход в облако вендора: корпоративный запрос, ушедший не туда, хуже
 *   любого отказа.
 * - ЗАГОЛОВКОВ КЛИЕНТА. Наверх уходит ровно то, что собрал шлюз. CLI, у
 *   которого в настройках стоит любой ключ-заглушка, не может ни подменить им
 *   ключ контура, ни утащить свой заголовок в чужую сеть.
 * - ТЕЛ И ТЕКСТОВ В СЛЕДЕ. В панель едут путь, код, стадии и НАЗВАНИЯ
 *   сработавших проверок; ни запроса, ни ответа, ни проверявшегося текста.
 */

/** Потолок тела: больше — почти наверняка вложенный файл, а не промпт. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Потолок СОБРАННОГО ответа (§8 №24). Касается только не-потокового клиента:
 * поток уходит наружу кусками и в памяти не копится, а вот «собери мне ответ
 * целиком» — это буфер, растущий ровно настолько, насколько контур решит
 * говорить. Один зациклившийся ответ занял бы память панели целиком, и
 * заметить это можно было бы лишь по упавшему процессу.
 *
 * Потолок ниже, чем у запроса: ответ модели в 32 МБ — это не ответ.
 */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** Три маршрута, и это всё. Остальное — честный 404, а не притворство. */
export const GATEWAY_ROUTES = ['/v1/chat/completions', '/v1/messages', '/v1/models'] as const;

export type GatewayRoute = 'chat' | 'messages' | 'models';

export interface PipelineDeps {
  store: AppStore;
  appDataDir: string;
  journal: GatewayJournal;
  /**
   * Постоянный учёт расхода (Т8). Необязателен: живой счётчик `journal` считает
   * от запуска процесса и нужен шлюзу всегда, а запись на диск — только там, где
   * шлюз поднял слушатель.
   */
  spend?: SpendFlusher;
  /** Подстановка транспорта для тестов. */
  fetchImpl?: PlatformFetch;
  now?: () => Date;
}

/** Какой из трёх маршрутов просят. Хвост `/v1` может отсутствовать у клиента. */
export function resolveRoute(path: string): GatewayRoute | undefined {
  const clean = (path.split('?')[0] ?? path).replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return 'chat';
  if (clean.endsWith('/messages')) return 'messages';
  if (clean.endsWith('/models')) return 'models';
  return undefined;
}

/** Диалект клиента однозначно задан маршрутом, а не заголовком. */
function dialectOf(route: GatewayRoute): Dialect {
  return route === 'messages' ? 'anthropic' : 'openai-compat';
}

/**
 * Единственное исключение из правила выше: у списка моделей путь в обоих
 * диалектах ОДИН И ТОТ ЖЕ (`/v1/models`), и маршрут о клиенте не говорит
 * ничего. Признак берётся тот, который API Anthropic требует от каждого
 * запроса, — `anthropic-version`; его шлют все клиенты этого диалекта.
 */
function modelsDialect(request: IncomingMessage): Dialect {
  return request.headers['anthropic-version'] === undefined ? 'openai-compat' : 'anthropic';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Разобрать адрес: первый сегмент — контур, остальное — маршрут API. */
export function splitPath(url: string): { platformId: string; rest: string } {
  const path = url.split('?')[0] ?? url;
  const parts = path.split('/').filter(Boolean);
  return { platformId: parts[0] ?? '', rest: `/${parts.slice(1).join('/')}` };
}

export async function handleGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PipelineDeps,
): Promise<void> {
  const url = request.url ?? '/';
  const { platformId, rest } = splitPath(url);
  const route = platformId ? resolveRoute(rest) : undefined;
  // В след запроса путь идёт БЕЗ строки запроса: часть CLI носит в ней свой
  // ключ (`?key=…`), а журнал шлюза уезжает на экран панели целиком.
  const path = url.split('?')[0] ?? url;

  if (!route) {
    return refuse(response, deps, {
      platformId,
      path,
      dialect: 'openai-compat',
      status: 404,
      code: 'not_found_error',
      message: `Шлюз панели принимает только ${GATEWAY_ROUTES.join(', ')} по адресу /<контур>/v1/...`,
    });
  }

  const dialect = route === 'models' ? modelsDialect(request) : dialectOf(route);
  const platform = findPlatform(deps.store, platformId);
  if (!platform) {
    return refuse(response, deps, {
      platformId,
      path,
      dialect,
      status: 404,
      code: 'not_found_error',
      message: `Контур «${platformId}» в панели не заведён`,
    });
  }

  const token = readToken(deps.appDataDir, platformId);
  if (!platform.enabled || !token) {
    return refuse(response, deps, {
      platformId,
      path,
      dialect,
      status: 502,
      code: 'api_error',
      message: !platform.enabled
        ? `Контур «${platform.title}» выключен в панели`
        : `У контура «${platform.title}» не сохранён ключ`,
    });
  }

  if (route === 'models') return models(response, deps, platform, token, path, dialect);
  return chat(request, response, deps, platform, token, path, dialect);
}

/**
 * Отказ по бюджету (402) записывается, откуда бы ни пришёл.
 *
 * Это ФАКТ про чужой лимит — но не про бюджет ключа. Контур отдаёт 402 с трёх
 * уровней (`user_daily`, `team_monthly`, `instance_monthly`), а исчерпанный
 * бюджет КЛЮЧА отдаёт кодом 401, неотличимым от отозванного ключа. Поэтому из
 * тела вынимается название уровня: без него отметка сообщала бы, что кончилось
 * не то, что кончилось.
 *
 * Записывается немедленно и переживает перезапуск, иначе карточка вернётся к
 * бодрому «запас есть» ровно там, где контур уже отказывает. Маршрутов у шлюза
 * три, и 402 приходит на любой: CLI спрашивает список моделей на старте, то
 * есть узнать об отказе панель может РАНЬШЕ первого чата — и раньше молча
 * забывала.
 */
function noteExhausted(
  deps: PipelineDeps,
  platformId: string,
  status: number,
  body?: unknown,
): void {
  if (status !== 402) return;
  deps.spend?.markExhausted(platformId, deps.now?.() ?? new Date(), budgetLevelOf(body));
}

/**
 * Название лимита из отказа контура: сообщение вида `budget exceeded: <level>`
 * (`inst-api/internal/api/handler_agent_chat.go`). Не разобралось — уровня нет,
 * и карточка скажет просто «отказ по бюджету»: угадывать, какой именно лимит
 * кончился, хуже, чем промолчать.
 */
function budgetLevelOf(body: unknown): string | undefined {
  const error = (body as { error?: { message?: unknown } } | undefined)?.error;
  const message = typeof error?.message === 'string' ? error.message : undefined;
  const level = /budget exceeded:\s*([a-z_]+)/i.exec(message ?? '')?.[1];
  return level ? level.toLowerCase() : undefined;
}

/** Список моделей: контур отдаёт его по-OpenAI, клиент читает своей схемой. */
async function models(
  response: ServerResponse,
  deps: PipelineDeps,
  platform: Platform,
  token: string,
  path: string,
  dialect: Dialect,
): Promise<void> {
  try {
    const upstream = await callUpstream({
      platform,
      token,
      path: 'models',
      method: 'GET',
      fetchImpl: deps.fetchImpl,
    });
    const text = await upstream.text();
    if (upstream.status >= 400) {
      const body = safeJson(text);
      noteExhausted(deps, platform.id, upstream.status, body);
      const bridged = bridgeUpstreamStatus(upstream.status, body);
      return refuse(response, deps, {
        platformId: platform.id,
        path,
        dialect,
        status: bridged.status,
        code: bridged.code,
        message: bridged.message,
        violations: bridged.violations,
        blocked: upstream.status === 451,
      });
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    // Клиенту в диалекте OpenAI список уходит байт в байт: пересобирая его, мы
    // потеряли бы поля, которых мост не знает, — и молча.
    response.end(
      dialect === 'anthropic' ? JSON.stringify(openAiModelsToAnthropic(safeJson(text))) : text,
    );
    record(deps, { platformId: platform.id, path, dialect, status: 200 });
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message : String(error);
    refuse(response, deps, {
      platformId: platform.id,
      path,
      dialect,
      status: 502,
      code: 'api_error',
      message,
    });
  }
}

async function chat(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PipelineDeps,
  platform: Platform,
  token: string,
  path: string,
  dialect: Dialect,
): Promise<void> {
  // Объявленный размер проверяется ДО чтения: 40-мегабайтное тело незачем
  // тянуть в память ради того, чтобы отказать в конце.
  const declared = Number(request.headers['content-length'] ?? 0);
  const raw = declared > MAX_BODY_BYTES ? undefined : await readBody(request);
  if (raw === undefined) {
    refuse(response, deps, {
      platformId: platform.id,
      path,
      dialect,
      status: 413,
      code: 'request_too_large',
      message: 'Тело запроса больше 32 МБ — шлюз его не принимает',
    });
    // Остаток тела читать некому: клиент, дописывающий свои сорок мегабайт в
    // закрытый ответ, ждал бы конца отправки, чтобы увидеть отказ.
    request.destroy();
    return;
  }

  const clientBody = safeJson(raw.toString('utf8'));
  if (!isRecord(clientBody)) {
    return refuse(response, deps, {
      platformId: platform.id,
      path,
      dialect,
      status: 400,
      code: 'invalid_request_error',
      message: 'Тело запроса не разбирается как JSON',
    });
  }

  // compromise: dialect-bridge — клиент говорит по-Anthropic, контур по-OpenAI; что не переносится, названо таблицей
  const translated =
    dialect === 'anthropic'
      ? anthropicRequestToOpenAi(clientBody)
      : // Перевода тут нет, а потери есть: контур принимает схемой половину
        // полей диалекта OpenAI и до модели их не доносит (справочник §5).
        // Без этой строки codex и cursor читали бы в следе «перенеслось всё»
        // ровно там, где молча пропали их инструменты.
        { body: clientBody, lost: openAiRequestLoss(clientBody) };
  const lost = translated.lost.map((item) => item.field);

  const settings = deps.store.getSettings();
  const wantsStream = clientBody.stream === true;
  const includeUsage =
    isRecord(clientBody.stream_options) && clientBody.stream_options.include_usage === true;
  const model = typeof translated.body.model === 'string' ? translated.body.model : '';

  let bodyText = JSON.stringify(
    forceStreamBody(translated.body, settings.platformGateway.forceStream),
  );

  // Словарь меток живёт РОВНО один запрос: метки минтятся на пути наверх и
  // разворачиваются обратно в этом же ответе. Общий на слушатель словарь
  // разворачивал бы метку, выданную запросу в контур A, внутри ответа контура B
  // — и рос бы до конца работы панели.
  const vault = new AliasVault();

  if (settings.dlp.enabled) {
    const guarded = applyRules(bodyText, deps, vault);
    if ('refusal' in guarded) {
      return refuse(response, deps, {
        platformId: platform.id,
        path,
        dialect,
        status: 403,
        code: 'invalid_request_error',
        message: guarded.refusal,
        lost,
      });
    }
    bodyText = guarded.body;
  }

  let upstream: Response;
  try {
    upstream = await callUpstream({
      platform,
      token,
      path: 'chat/completions',
      body: bodyText,
      signal: abortSignalOf(request),
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message : String(error);
    return refuse(response, deps, {
      platformId: platform.id,
      path,
      dialect,
      status: 502,
      code: 'api_error',
      message,
      lost,
    });
  }

  if (upstream.status >= 400) {
    // Тело контура наружу НЕ идёт: в перечне нарушений 451 вполне может лежать
    // кусок самого запроса. Клиент получает свою форму и русскую причину.
    const body = safeJson(await upstream.text());
    noteExhausted(deps, platform.id, upstream.status, body);
    // Модель уточняет 403 и 404: без её имени первый непонятно про что, а
    // второй читается как «нет такого маршрута». `Retry-After` — вторая
    // половина 429: свой повтор шлюз уже сделал, и человеку остаётся знать,
    // через сколько имеет смысл повторять ему.
    const bridged = bridgeUpstreamStatus(upstream.status, body, {
      model,
      retryAfterSeconds: retryAfterSeconds(upstream),
    });
    return refuse(response, deps, {
      platformId: platform.id,
      path,
      dialect,
      status: bridged.status,
      code: bridged.code,
      message: bridged.message,
      violations: bridged.violations,
      // Отказ проверок отличается от отказа ключа: 451 здесь ещё виден, а
      // клиенту он уедет четырёхсотым и станет неотличим от прочих.
      blocked: upstream.status === 451,
      lost,
    });
  }

  const translator = new StreamTranslator({ dialect, model, includeUsage });
  const restore = new ResponseStreamFilter(dialect, vault.reverse());

  const source = await readSource(upstream);
  if (!source) {
    return refuse(response, deps, {
      platformId: platform.id,
      path,
      dialect,
      status: 502,
      code: 'api_error',
      message: 'Контур ответил не потоком, и его тело не разбирается как ответ модели',
      lost,
    });
  }

  // Всё, что дальше, обязано ДОЙТИ ДО СЛЕДА. Обрыв на середине потока — не
  // исключение из работы шлюза, а его будни (контур перезапускается), и запрос,
  // исчезнувший из журнала вместе с расходом, оставляет человека без
  // единственного места, где эту беду видно.
  let failure: string | undefined;
  try {
    if (wantsStream) await streamToClient(response, source, translator, restore);
    else await collectForClient(response, source, translator, vault, dialect, model);
  } catch (error) {
    failure = response.destroyed
      ? 'Клиент отключился до конца ответа'
      : `Ответ контура оборвался: ${error instanceof Error ? error.message : String(error)}`;
    finishBroken(response, translator, restore, dialect, failure);
  }

  const facts = translator.facts;
  const at = deps.now?.() ?? new Date();
  deps.journal.addUsage(
    platform.id,
    {
      promptTokens: facts.promptTokens,
      completionTokens: facts.completionTokens,
      totalTokens: facts.totalTokens,
    },
    at,
  );
  // Постоянный учёт — ПОСЛЕ ответа клиенту и пачкой (см. `spend-flush.ts`):
  // ответ модели не имеет права ждать нашу бухгалтерию. Модель называем ту, что
  // ушла наверх: по ней ищется цена, и без неё расход виден только в токенах.
  deps.spend?.add(
    platform.id,
    {
      model,
      promptTokens: facts.promptTokens,
      completionTokens: facts.completionTokens,
      totalTokens: facts.totalTokens,
    },
    at,
  );
  record(deps, {
    platformId: platform.id,
    path,
    dialect,
    status: failure
      ? response.destroyed
        ? 499
        : 502
      : facts.interrupted
        ? 400
        : facts.truncated
          ? 502
          : 200,
    stages: facts.stages,
    summarized: facts.summarized,
    violations: facts.violations,
    masked: facts.masked,
    interrupted: facts.interrupted,
    unknownFrames: facts.unknownFrames,
    totalTokens: facts.totalTokens,
    lost,
    error:
      failure ??
      (facts.interrupted
        ? 'Проверки контента контура остановили ответ'
        : facts.truncated
          ? TRUNCATED_MESSAGE
          : undefined),
  });
}

/**
 * Ответ контура: поток кадрами либо цельное тело.
 *
 * Второе случается, когда перевод в поток выключен настройкой (`forceStream`) —
 * и молча выбрасывалось бы разборщиком кадров целиком: клиент получал бы пустой
 * ответ, нулевой расход и код 200. Поэтому цельное тело превращается в те же
 * кадры, и дальше конвейер остаётся ОДИН — а не два, из которых второй никто
 * никогда не проверял.
 */
async function readSource(upstream: Response): Promise<UpstreamSource | undefined> {
  if ((upstream.headers.get('content-type') ?? '').includes('event-stream')) {
    return { stream: upstream };
  }
  const frames = framesFromCompletion(await upstream.text());
  return frames === undefined ? undefined : { frames };
}

/** Цельный ответ контура → кадры потока. `undefined` — это вообще не ответ модели. */
function framesFromCompletion(text: string): string | undefined {
  // Контур прислал поток, не назвав его потоком: это всё-таки кадры.
  const head = text.trimStart();
  if (head.startsWith('data:') || head.startsWith('event:')) return text;

  const payload = safeJson(text);
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;

  const choice = isRecord(payload.choices[0]) ? payload.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const skeleton = {
    ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    object: 'chat.completion.chunk',
  };

  const chunk = {
    ...skeleton,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: contentText(message.content) },
        finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      },
    ],
  };
  const usage = { ...skeleton, choices: [], usage: isRecord(payload.usage) ? payload.usage : {} };

  // Вендорные поля цельного тела — отдельными кадрами ВПЕРЕДИ ответа. В цельном
  // теле живут как раз вердикты по выходу (справочник §7), и пересобрав из него
  // только `choices` и `usage`, конвейер терял их целиком: запрос, по которому
  // контур вынес решение, приезжал в панель как «проверки молчали».
  const vendor = VENDOR_FIELDS.filter((field) => payload[field] !== undefined).map(
    (field) => `data: ${JSON.stringify({ [field]: payload[field] })}\n\n`,
  );

  // Порядок как в потоке: сначала текст, потом вердикт. Обратный порядок оборвал
  // бы ответ до того, как клиент увидел то, что контур всё-таки прислал.
  return `data: ${JSON.stringify(chunk)}\n\n${vendor.join('')}data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`;
}

/** Поля контура, которые цельное тело несёт рядом с ответом. */
const VENDOR_FIELDS = [
  'enterprise-platform_guardrails',
  'enterprise-platform_sanitized',
  'enterprise-platform_status',
  'enterprise-platform_tools_unavailable',
] as const;

/** Текст ответа: строкой либо частями — обе формы законны у совместимых шлюзов. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Клиенту, которому уже льётся поток, беда сообщается кадром ошибки: молча
 * закрытый поток он покажет как удачный короткий ответ. Заголовки ещё не ушли —
 * отвечаем обычным отказом.
 */
function finishBroken(
  response: ServerResponse,
  translator: StreamTranslator,
  restore: ResponseStreamFilter,
  dialect: Dialect,
  message: string,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) {
    respond(response, 502, errorBody(dialect, `AgentDeck: ${message}`, 'api_error'));
    return;
  }
  response.end(restore.push(translator.fail(`AgentDeck: ${message}`)) + restore.end());
}

/** Поток наружу: заголовки уходят сразу, тело — кусками, без буфера целиком. */
async function streamToClient(
  response: ServerResponse,
  source: UpstreamSource,
  translator: StreamTranslator,
  restore: ResponseStreamFilter,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Первые токены видны до конца ответа — ради этого поток и нужен.
  response.flushHeaders();

  await pump(
    source,
    async (text) => {
      await write(response, restore.push(translator.push(text)));
    },
    () => response.destroyed,
  );

  const tail = restore.push(translator.end()) + restore.end();
  response.end(tail);
}

/**
 * Запись клиенту с оглядкой на его скорость. Без ожидания `drain` быстрый
 * контур и медленный CLI дают ровно то, от чего шлюз бережётся в другую
 * сторону: весь ответ копится в памяти панели.
 */
function write(response: ServerResponse, text: string): Promise<void> {
  if (!text || response.destroyed) return Promise.resolve();
  if (response.write(text)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    // Ушедший клиент `drain` уже не пришлёт — ждать его пришлось бы вечно.
    response.once('close', done);
  });
}

/**
 * Клиент просил не поток: наверх всё равно ушёл поток (`nonstream-120s`), а
 * ответ шлюз собирает сам и отдаёт цельным телом того диалекта, на котором
 * спросили.
 */
async function collectForClient(
  response: ServerResponse,
  source: UpstreamSource,
  translator: StreamTranslator,
  vault: AliasVault,
  dialect: Dialect,
  model: string,
): Promise<void> {
  // Счёт идёт по кускам, а не по собранному телу: смысл потолка в том, чтобы
  // не дорасти до него, а не узнать о превышении, уже держа всё в памяти.
  let collected = 0;
  let overflow = false;

  await pump(
    source,
    (text) => {
      collected += Buffer.byteLength(text, 'utf8');
      if (collected > MAX_ANSWER_BYTES) {
        overflow = true;
        return;
      }
      translator.push(text);
    },
    () => response.destroyed || overflow,
  );
  translator.end();

  if (overflow) {
    // 413 и здесь: клиент разбирает его тем же кодом, что и слишком большой
    // запрос, а «слишком длинный ответ» ему не объяснит никакой 502.
    respond(
      response,
      413,
      errorBody(
        dialect,
        'Ответ контура больше 8 МБ — шлюз не собирает его целиком. Тот же запрос потоком приходит без этого потолка',
        'request_too_large',
      ),
    );
    return;
  }

  const answer = translator.assembled();
  if (translator.facts.interrupted) {
    const names = translator.facts.violations.join(', ');
    const message = names
      ? `Проверки контента контура остановили ответ: ${names}`
      : 'Проверки контента контура остановили ответ';
    respond(response, 400, errorBody(dialect, message, 'content_policy_violation'));
    return;
  }

  // Недосказанный ответ цельным телом не отдаётся вовсе: в потоке клиент хотя
  // бы видит, где оборвалось, а здесь получил бы обрезок под видом целого.
  if (translator.facts.truncated) {
    respond(response, 502, errorBody(dialect, `AgentDeck: ${TRUNCATED_MESSAGE}`, 'api_error'));
    return;
  }

  const completion = {
    id: answer.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: answer.model || model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: answer.text },
        finish_reason: answer.finishReason,
      },
    ],
    usage: {
      prompt_tokens: answer.promptTokens,
      completion_tokens: answer.completionTokens,
      total_tokens: answer.totalTokens,
    },
  };

  const body =
    dialect === 'anthropic'
      ? openAiResponseToAnthropic(completion, answer.model || model)
      : completion;
  // Обратная подстановка меток — в форме того диалекта, в котором отвечаем.
  respond(response, 200, restoreJsonResponse(body, dialect, vault.reverse()));
}

/**
 * Тело запроса с потолком. Превышение НЕ дочитывается: смысл потолка в том,
 * чтобы 40-мегабайтный файл не оказался в памяти панели целиком.
 */
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

/** Ответ контура: поток кадрами либо готовые кадры из цельного тела. */
type UpstreamSource = { stream: Response } | { frames: string };

/**
 * Прочитать ответ кусками. Многобайтовый символ собирает decoder.
 *
 * `gone` — «клиент ушёл»: чтение прекращается и поток НАВЕРХУ отменяется. Без
 * этого контур продолжает отвечать и списывать расход в соединение, которого
 * уже нет.
 */
async function pump(
  source: UpstreamSource,
  onText: (text: string) => void | Promise<void>,
  gone: () => boolean,
): Promise<void> {
  if ('frames' in source) {
    await onText(source.frames);
    return;
  }

  const body = source.stream.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    if (gone()) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) await onText(text);
  }
  const tail = decoder.decode();
  if (tail) await onText(tail);
}

/**
 * Правила защиты данных на теле, которое уйдёт наверх.
 *
 * Fail-closed в обе стороны: сломанный файл правил при включённой защите — это
 * отказ, а не тихий проход. Иначе защита, о которой человек думает, что она
 * работает, молча перестаёт работать.
 */
function applyRules(
  bodyText: string,
  deps: PipelineDeps,
  vault: AliasVault,
): { body: string } | { refusal: string } {
  let rules;
  try {
    rules = readRules(deps.appDataDir);
  } catch (error) {
    return {
      refusal: `Защита данных включена, а правила не читаются (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const masked = maskRequestBody(bodyText, 'openai-compat', rules, vault);
  if (!masked) return { refusal: 'Защита данных не разобрала тело запроса' };
  if (masked.blockedBy) {
    return {
      refusal: `Запрос остановлен правилом «${masked.blockedBy.ruleName}» — в нём нашлись данные, которые не должны уходить в модель`,
    };
  }
  return { body: masked.body };
}

interface Refusal {
  platformId: string;
  path: string;
  dialect: Dialect;
  status: number;
  code: string;
  message: string;
  violations?: string[];
  lost?: string[];
  /** Отказ пришёл от проверок содержимого (451), а не от ключа или бюджета. */
  blocked?: boolean;
}

/** Отказ: форма диалекта клиента, русская причина, след в панель. */
function refuse(response: ServerResponse, deps: PipelineDeps, refusal: Refusal): void {
  respond(
    response,
    refusal.status,
    errorBody(refusal.dialect, `AgentDeck: ${refusal.message}`, refusal.code),
  );
  record(deps, {
    platformId: refusal.platformId,
    path: refusal.path,
    dialect: refusal.dialect,
    status: refusal.status,
    violations: refusal.violations,
    blocked: refusal.blocked,
    lost: refusal.lost,
    error: refusal.message,
  });
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** След запроса. Умолчания — пустые: пусто честнее выдуманного. */
function record(deps: PipelineDeps, event: Partial<PlatformGatewayEvent>): void {
  deps.journal.addEvent({
    at: (deps.now?.() ?? new Date()).toISOString(),
    platformId: event.platformId ?? '',
    path: event.path ?? '',
    dialect: event.dialect ?? '',
    status: event.status ?? 0,
    stages: event.stages ?? [],
    summarized: event.summarized ?? false,
    violations: event.violations ?? [],
    masked: event.masked ?? false,
    blocked: event.blocked ?? false,
    interrupted: event.interrupted ?? false,
    unknownFrames: event.unknownFrames ?? [],
    lost: event.lost ?? [],
    totalTokens: event.totalTokens ?? 0,
    error: event.error,
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Клиент отвалился — обрываем и наверху, чтобы не платить за ненужный ответ. */
function abortSignalOf(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.on('close', () => controller.abort());
  return controller.signal;
}
