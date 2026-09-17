import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  Platform,
  PlatformApplyPlan,
  PlatformApplyResult,
  PlatformAgentMessage,
  PlatformEmbeddingResult,
  PlatformGatewayInfo,
  PlatformRollbackResult,
  PlatformsInfo,
  PlatformSpendInfo,
} from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { parseBody } from '../lib/request-body.ts';
import { platformSchema } from '../providers/settings-validation.ts';
import { EndpointApplyError } from '../domains/endpoints/endpoint-apply.ts';
import { EnvKeyNotEncodableError, EnvKeyPreservedError } from '../domains/provider-env.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';
import { readCaCert } from '../domains/platform/ca-fetch.ts';
import { assertTransport } from '../domains/platform/transport.ts';
import { assertManifest } from '../domains/platform/manifest.ts';
import { checkPlatform } from '../domains/platform/check.ts';
import {
  activatePlatform,
  deactivatePlatform,
  type ContourActivationDeps,
} from '../domains/platform/activation.ts';
import { PlatformError, invalidField } from '../domains/platform/errors.ts';
import type { PlatformGateway } from '../domains/platform/gateway/listener.ts';
import { applyContour } from '../domains/platform/apply/apply.ts';
import { buildPlatformApplyPlan, type ContourApplyDeps } from '../domains/platform/apply/plan.ts';
import { rollbackContour } from '../domains/platform/apply/rollback.ts';
import { reconcileManagedProfiles } from '../domains/platform/apply/profile.ts';
import type { PanelBridgeTarget } from '../domains/panel-mcp.ts';
import { askAgent, readAgentSession, resetAgentSession } from '../domains/platform/agents.ts';
import {
  isPlatformMcpRegistered,
  platformMcpRefusal,
  registerPlatformMcp,
  unregisterPlatformMcp,
  PLATFORM_MCP_ID,
} from '../domains/platform/mcp-bridge.ts';
import { embedTexts, EmbeddingError } from '../domains/platform/embeddings.ts';
import { describeRunPlan } from '../domains/platform/routing.ts';
import { driverOf } from '../domains/platform/drivers/index.ts';
import { brokenExclusion } from '../domains/platform/rules-matrix.ts';
import {
  clearExhausted,
  emptySpend,
  gatewayPricing,
  spendInfo,
} from '../domains/platform/spend.ts';
import {
  assertToken,
  describePlatform,
  describePlatforms,
  findPlatform,
  removePlatform,
  requireConnected,
  requirePlatform,
  writePlatform,
  writeToken,
} from '../domains/platform/store.ts';

/**
 * Контуры: показать, сохранить, проверить связь, удалить.
 *
 * ГЛАВНОЕ СВОЙСТВО РАЗДЕЛА: ни один ответ здесь не содержит ключа. Наружу
 * уходит только маска (`sk-…4f21`) и признак «ключ сохранён» — этого хватает,
 * чтобы человек узнал свой ключ, и не хватает, чтобы им воспользоваться.
 * Поэтому ключ приходит отдельным полем и только когда его ТРОНУЛИ: форма,
 * присылающая настройку без поля ключа, с ключом ничего не делает.
 *
 * Сеть здесь ровно в одном месте — `POST /:id/check`, по нажатию человека.
 * Ни один из остальных маршрутов наружу не ходит, и при старте панели не
 * ходит никто: включённый контур не делает ни одного запроса, пока его не
 * попросили (инвариант 7 — мёртвый контур не мешает панели).
 */
export function registerPlatformRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  gateway: PlatformGateway,
  /**
   * Адрес самой панели. Нужен ровно одному маршруту — регистрации переходника
   * MCP: в его записи лежит только этот адрес, и никогда ключ контура. Порт
   * известен лишь при сборке, поэтому приходит извне.
   */
  selfBaseUrl = 'http://127.0.0.1:5178',
): void {
  const appData = (): string => ctx.location.paths.appData;

  const gatewayInfo = (): PlatformGatewayInfo => ({
    settings: ctx.store.getSettings().platformGateway,
    status: gateway.status(),
  });

  /**
   * Состояние шлюза. Отдельно от списка контуров: слушатель один на все, и
   * его порт с адресами — не свойство конкретного контура.
   */
  app.get('/api/platforms/gateway', () => gatewayInfo());

  /**
   * Поднять, погасить или перезапустить слушатель ПО НАСТРОЙКЕ. Своих
   * параметров у маршрута нет намеренно: настройки правятся общим PATCH, а
   * здесь применяется уже сохранённое — иначе состояние экрана и состояние
   * слушателя разъехались бы на первом же отказе.
   */
  const startGateway = (): Promise<unknown> =>
    gateway.start({
      store: ctx.store,
      appDataDir: appData(),
      port: ctx.store.getSettings().platformGateway.port,
      pricing: gatewayPricing(ctx.store, ctx.pricing),
    });

  /**
   * Активация поднимает погашенный шлюз сама: включает настройку тем же
   * порядком, что мастер («Поднять шлюз»), и сверяет управляемые профили, как
   * общий PATCH настроек шлюза.
   */
  const ensureGateway = async (): Promise<void> => {
    if (gateway.status().running) return;
    const settings = ctx.store.getSettings().platformGateway;
    if (!settings.enabled) {
      ctx.store.updateSettings({ platformGateway: { ...settings, enabled: true } });
      reconcileManagedProfiles(ctx.store);
    }
    await startGateway();
  };

  /**
   * «Поднять шлюз» с карточки контура: включить настройку и поднять слушатель
   * одним вызовом — тем же `ensureGateway`, что и активация. Живой шлюз не
   * перезапускается: кнопку жмут, когда он погас, а не чтобы оборвать прогоны.
   */
  app.post('/api/platforms/gateway/start', async (_request, reply) => {
    try {
      await ensureGateway();
      return gatewayInfo();
    } catch (error) {
      return reply.code(409).send({
        code: 'gateway_start_failed',
        message: 'Шлюз не поднялся',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/platforms/gateway/restart', async (_request, reply) => {
    const settings = ctx.store.getSettings().platformGateway;
    try {
      if (!settings.enabled) {
        await gateway.stop();
        return gatewayInfo();
      }
      await startGateway();
      return gatewayInfo();
    } catch (error) {
      // Не поднявшийся слушатель — это состояние с причиной, а не 500: адрес
      // человек всё равно читает с этого же экрана.
      return reply.code(409).send({
        code: 'gateway_start_failed',
        message: 'Шлюз не поднялся',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * Список контуров одним ответом: карточки, активный и разовый рассказ о
   * переносе. Собирается в одном месте — второй сборки хватило бы, чтобы
   * удаление контура отвечало без активного, а список с ним.
   */
  const platformsInfo = (): PlatformsInfo => {
    const notice = ctx.store.getPlatformActivationNotice();
    return {
      platforms: describePlatforms(ctx.store, appData()),
      activePlatformId: ctx.store.getSettings().activePlatformId,
      ...(notice ? { activationNotice: notice } : {}),
    };
  };

  /**
   * Чем пойдёт прогон этого потребителя, если запустить его сейчас (Т6): модель
   * контура, правила её выбора и принимает ли контур усилие.
   *
   * Отдельным коротким маршрутом, а не полем карточки: спрашивает шапка чата на
   * каждом открытии разговора, а карточка везёт каталог моделей, пробу и учёт
   * расхода — мегабайты ради одной подписи под селектором.
   *
   * Своим корнем, а не сегментом внутри `/api/platforms/:id/…` (ревью Т6, m11):
   * статический сегмент сильнее параметра, и контур с идентификатором
   * `run-plan` перекрыл бы собственные маршруты.
   */
  app.get<{ Params: { consumer: string } }>('/api/platform-run-plan/:consumer', (request) =>
    describeRunPlan(
      {
        store: ctx.store,
        appDataDir: appData(),
        gatewayPort: () => (gateway.status().running ? gateway.status().port : 0),
      },
      request.params.consumer,
    ),
  );

  app.get('/api/platforms', () => {
    // Хвост учёта дописываем ПЕРЕД чтением: расход копится пачкой (см.
    // `gateway/spend-flush.ts`), и карточка, открытая сразу после ответа
    // модели, иначе показывала бы цифру пятисекундной давности.
    gateway.flushSpend();
    return platformsInfo();
  });

  /**
   * Сохранить контур целиком. Идентификатор берётся ИЗ ПУТИ: переименование —
   * это удаление и создание, потому что ключ лежит под старым идентификатором и
   * молча переехавшая настройка осталась бы без него.
   *
   * Ключ — необязательное поле РЯДОМ с настройкой, а не внутри неё: форма
   * мастера сохраняет и то и другое одним нажатием, а форма редактирования
   * поля ключа не присылает вовсе — и сохранённый ключ остаётся на месте.
   */
  app.put<{ Params: { id: string }; Body: unknown }>('/api/platforms/:id', (request, reply) => {
    const id = request.params.id;
    const body = request.body as { settings?: unknown; token?: unknown } | undefined;
    const settings = parseBody(platformSchema, body?.settings, reply);
    if (settings === undefined) return reply;

    try {
      // Сырое тело, а не разобранное: схема общего PATCH негодное поле
      // переопределений роняет молча, и отказ с именем возможен только до неё.
      assertManifest((body?.settings as { manifest?: unknown } | undefined)?.manifest);
      const platform = settings as Platform;
      if (platform.id !== id) {
        throw invalidField(
          'id',
          `идентификатор в адресе («${id}») и в теле («${platform.id}») не совпадают`,
        );
      }
      // Всё, что может отказать, проверяется ДО первой записи: иначе отказ на
      // ключе оставил бы сохранённой настройку, которую человек не просил
      // сохранять отдельно от него.
      if (body?.token !== undefined && typeof body.token !== 'string') {
        throw invalidField('token', 'ключ должен быть строкой');
      }
      if (typeof body?.token === 'string') assertToken(body.token.trim());
      // Сертификат проверяем ЗДЕСЬ, а не при пробе: человек узнаёт про
      // непрочитанный файл, сохраняя форму, а не через отказ связи потом.
      if (platform.caCertPath.trim()) readCaCert(platform.caCertPath.trim());
      // Транспорт — там же и по той же причине; значение в отказ не попадает.
      assertTransport(platform);
      // Взаимное исключение матрицы (Т7) — отказ, а не тихая починка: панель,
      // сама снявшая прослойку ради списка инструментов контура, приняла бы за
      // человека решение, которого он не принимал, и он узнал бы о нём по
      // молчащему агенту.
      //
      // Но отказ стоит РОВНО на попытке свести обе стороны, а не на каждом
      // сохранении противоречивого контура. Противоречие приезжает мимо этой
      // двери — разворот архива, `PATCH /api/settings`, импорт снимка, — и
      // отказ «по состоянию» запирал бы контур насмерть: переименование,
      // адрес, модель, агенты, ключ — всё получало 400 про инструменты, а
      // выйти было нечем (ревью Т7, B3). Пришедшее противоречие, которое уже
      // лежит в настройке, проходит: карточка о нём кричит и даёт оба выхода.
      const driver = driverOf(platform);
      const broken = brokenExclusion(platform, driver);
      const known = findPlatform(ctx.store, id);
      // Контура в настройках ещё нет — значит противоречие сводит ИМЕННО это
      // сохранение, и оно получает отказ.
      const wasBroken = known ? brokenExclusion(known, driver) : undefined;
      if (broken && !wasBroken) throw invalidField('rules.platform.platformTools', broken.detail);

      // Тумблер контура сохранением НЕ меняется: включён — значит активен, а
      // активность переключается своим маршрутом, транзакцией (инвариант 1).
      // Иначе обычная правка названия заводила бы второй включённый контур, и
      // «через какой из них идёт работа» снова становилось бы вопросом с двумя
      // ответами. Пришедшее значение молча заменяется на сегодняшнее — форма
      // его не показывает и не спрашивает.
      const stored = { ...platform, enabled: ctx.store.getSettings().activePlatformId === id };
      writePlatform(ctx.store, stored);
      if (typeof body?.token === 'string') writeToken(appData(), platform.id, body.token.trim());
      return describePlatform(ctx.store, appData(), stored);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Живая проверка. Никогда не отвечает отказом связи: недоступный контур — это
   * результат пробы с причиной, а не 502 в консоли браузера.
   */
  app.post<{ Params: { id: string } }>('/api/platforms/:id/check', async (request, reply) => {
    try {
      return await checkPlatform(ctx.store, appData(), request.params.id);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Общие для применения и отката зависимости — пути, копии, живость шлюза. */
  const applyDeps = (): ContourApplyDeps => ({
    store: ctx.store,
    paths: {
      claudeSettings: ctx.location.paths.settings,
      override: ctx.store.getSettings().claudeDirOverride,
    },
    backupDir: ctx.backupDir,
    // Именно ПОДНЯТ, а не «включён в настройках»: применить контур к CLI,
    // который упрётся в закрытый порт, значит соврать человеку.
    gatewayRunning: gateway.status().running,
  });

  /**
   * Зависимости активации — те же пути и копии, что у отката, плюс каталог
   * данных: проба читает ключ, а пробный запрос идёт в свой же шлюз.
   * Живость шлюза сюда не входит намеренно: активировать контур при погашенном
   * шлюзе можно, и об этом говорит сам пробный запрос, а не отказ маршрута.
   */
  const activationDeps = (): ContourActivationDeps => ({
    store: ctx.store,
    paths: {
      claudeSettings: ctx.location.paths.settings,
      override: ctx.store.getSettings().claudeDirOverride,
    },
    backupDir: ctx.backupDir,
    appDataDir: appData(),
    // Порт — у живого слушателя. Записанный в состоянии остаётся от прошлого
    // запуска, и пробный запрос ушёл бы процессу, который занял порт после
    // убитой панели.
    gatewayPort: () => (gateway.status().running ? gateway.status().port : 0),
    ensureGateway,
  });

  /**
   * Предпросмотр применения: что и куда ляжет, что уже занято, что панель уже
   * писала и что человек правил после неё. Ни одной записи здесь не происходит.
   */
  app.get<{ Params: { id: string } }>('/api/platforms/:id/apply', (request, reply) => {
    try {
      const platform = requirePlatform(ctx.store, request.params.id);
      return buildPlatformApplyPlan(applyDeps(), platform) satisfies PlatformApplyPlan;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Применить к названным целям. Цель с занятым местом пишется только когда она
   * названа ещё и в `overwrite`, то есть когда человек увидел, что там стоит;
   * иначе она возвращается в `skipped` с причиной.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/platforms/:id/apply',
    (request, reply) => {
      const body = request.body as
        { targets?: unknown; overwrite?: unknown; model?: unknown } | undefined;
      try {
        const platform = requirePlatform(ctx.store, request.params.id);
        const targets = stringList(body?.targets, 'targets');
        const overwrite =
          body?.overwrite === undefined ? [] : stringList(body.overwrite, 'overwrite');
        if (body?.model !== undefined && typeof body.model !== 'string') {
          throw invalidField('model', 'модель должна быть строкой');
        }
        return applyContour(applyDeps(), platform, {
          targets,
          overwrite,
          ...(typeof body?.model === 'string' ? { model: body.model } : {}),
        }) satisfies PlatformApplyResult;
      } catch (error) {
        return failWrite(reply, error);
      }
    },
  );

  /**
   * Снять применение: файлы возвращаются в исходный вид, управляемый профиль
   * удаляется. Сам контур остаётся — снимается применение, а не настройка;
   * файл, который человек правил после нас, не трогается и называется в ответе.
   *
   * `targets` в теле снимает точечно — одну строку журнала. Пусто (тела нет) —
   * снимается всё: это же тело приходит от кнопки «Отключить контур».
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/platforms/:id/disable',
    (request, reply) => {
      const body = request.body as { targets?: unknown } | undefined;
      try {
        requirePlatform(ctx.store, request.params.id);
        const targetIds =
          body?.targets === undefined ? undefined : stringList(body.targets, 'targets');
        return rollbackContour(applyDeps(), request.params.id, {
          ...(targetIds ? { targetIds } : {}),
        }) satisfies PlatformRollbackResult;
      } catch (error) {
        return failWrite(reply, error);
      }
    },
  );

  /**
   * Сделать контур активным (Т2). Одним нажатием: снять применения прежнего,
   * погасить чужие тумблеры, зажечь свой, сходить пробой и задать модели один
   * вопрос через собственный шлюз.
   *
   * Сеть здесь есть, но отказом связи маршрут не отвечает: красная проба и
   * молчащая модель приезжают ВНУТРИ ответа, потому что активация к этому
   * моменту уже случилась (Р3) и человеку нужно видеть, что именно не так.
   */
  app.post<{ Params: { id: string } }>('/api/platforms/:id/activate', async (request, reply) => {
    try {
      return await activatePlatform(activationDeps(), request.params.id);
    } catch (error) {
      return failWrite(reply, error);
    }
  });

  /**
   * Вернуть провайдер по умолчанию. Один маршрут на две кнопки — на карточке
   * контура и в строке провайдера: это одно действие, и два его исполнения
   * разошлись бы в первый же месяц.
   */
  app.post<{ Params: { id: string } }>('/api/platforms/:id/deactivate', (request, reply) => {
    try {
      return deactivatePlatform(
        activationDeps(),
        request.params.id,
      ) satisfies PlatformRollbackResult;
    } catch (error) {
      return failWrite(reply, error);
    }
  });

  /**
   * Погасить рассказ о переносе старых настроек: человек прочитал. Навсегда —
   * повторно показанный, он читается как новое событие.
   */
  app.delete('/api/platforms/activation-notice', () => {
    ctx.store.clearPlatformActivationNotice();
    return platformsInfo();
  });

  /**
   * Удалить: настройка, ключ и след пробы уходят вместе. Применение снимается
   * ПЕРЕД удалением — иначе конфиги CLI остались бы указывать на маршрут шлюза,
   * которого больше нет, и человеку некому было бы это откатить.
   */
  app.delete<{ Params: { id: string } }>('/api/platforms/:id', (request, reply) => {
    try {
      requirePlatform(ctx.store, request.params.id);
      rollbackContour(applyDeps(), request.params.id);
      removePlatform(ctx.store, appData(), request.params.id);
      return platformsInfo();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Спросить опубликованного агента контура.
   *
   * Ответ ВСЕГДА 200 с исходом внутри: «агентов нет в лицензии компании» —
   * это отсутствующая возможность, а не сбой, и 502 в консоли браузера послал
   * бы человека чинить то, что не ломалось. Отказывает маршрут только до сети:
   * контура нет (404), контур не подключён (404), поле не заполнено (400).
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/platforms/:id/agents/ask',
    async (request, reply) => {
      const body = request.body as
        { agent?: unknown; message?: unknown; messages?: unknown; session?: unknown } | undefined;
      try {
        const platform = requirePlatform(ctx.store, request.params.id);
        const token = requireConnected(ctx.store, appData(), platform.id);
        const agentId = requireString(body?.agent, 'agent', 'не назван агент');
        const session = optionalString(body?.session, 'session');
        return await askAgent({
          platform,
          token,
          agentId,
          messages: readMessages(body),
          ...(session ? { sessionId: session } : {}),
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Что помнит контур о сессии. Своей копии переписки панель не держит: она
   * разошлась бы с той историей, из которой агент на самом деле отвечает.
   */
  app.get<{ Params: { id: string; sessionId: string }; Querystring: { agent?: string } }>(
    '/api/platforms/:id/agents/sessions/:sessionId',
    async (request, reply) => {
      try {
        const platform = requirePlatform(ctx.store, request.params.id);
        const token = requireConnected(ctx.store, appData(), platform.id);
        const result = await readAgentSession({
          platform,
          token,
          sessionId: request.params.sessionId,
          ...(request.query.agent ? { agentId: request.query.agent } : {}),
        });
        // Отказ контура — 502 с его причиной: в отличие от вызова агента,
        // «сессию не прочитали» не бывает законным состоянием экрана.
        if ('error' in result) {
          return reply.code(502).send({ code: 'agent_session_failed', message: result.error });
        }
        return result;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Забыть переписку сессии. Идемпотентно: стирать было нечего — тоже успех. */
  app.delete<{ Params: { id: string; sessionId: string } }>(
    '/api/platforms/:id/agents/sessions/:sessionId',
    async (request, reply) => {
      try {
        const platform = requirePlatform(ctx.store, request.params.id);
        const token = requireConnected(ctx.store, appData(), platform.id);
        const result = await resetAgentSession({
          platform,
          token,
          sessionId: request.params.sessionId,
        });
        if ('error' in result) {
          return reply.code(502).send({ code: 'agent_session_failed', message: result.error });
        }
        return { ok: true };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Эмбеддинги контура — числа для нашего поиска. Модель называет вызывающий:
   * подставить её за него значило бы гадать по имени модели.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/platforms/:id/embeddings',
    async (request, reply) => {
      const body = request.body as { model?: unknown; input?: unknown } | undefined;
      try {
        const platform = requirePlatform(ctx.store, request.params.id);
        const token = requireConnected(ctx.store, appData(), platform.id);
        const model = requireString(body?.model, 'model', 'не названа модель эмбеддингов');
        const input =
          typeof body?.input === 'string' ? [body.input] : stringList(body?.input, 'input');
        return (await embedTexts({
          platform,
          token,
          model,
          input,
        })) satisfies PlatformEmbeddingResult;
      } catch (error) {
        if (error instanceof EmbeddingError) {
          return reply
            .code(error.status)
            .send({ code: 'embeddings_failed', message: error.message });
        }
        return fail(reply, error);
      }
    },
  );

  /**
   * Переходник MCP: дать локальному агенту те же инструменты контура, что есть
   * у человека на экране. Регистрация — кнопка и ничем иным: запись уходит в
   * конфигурацию CLI, а не в состояние панели.
   *
   * В записи НЕТ ключа контура — только адрес панели. Переходник ходит сюда, а
   * в контур ходит уже панель.
   */
  const bridgeTarget = (): PanelBridgeTarget => ({
    mcpConfigPath: ctx.location.paths.mcpConfig,
    backupDir: ctx.backupDir,
    selfBaseUrl,
    // Настройки решают, в чей конфиг уйдёт запись: у Claude свой файл, у
    // остальных девяти CLI — их собственный раздел MCP.
    store: ctx.store,
  });

  app.get('/api/platforms/mcp/connect', () => {
    // Причину, по которой записать некуда, отдаём ВМЕСТЕ с состоянием: кнопка
    // обязана погаснуть с объяснением, а не отказать по нажатию.
    const blockedReason = platformMcpRefusal(ctx.store);
    return {
      name: PLATFORM_MCP_ID,
      connected: isPlatformMcpRegistered(ctx.location.paths.mcpConfig, ctx.store),
      ...(blockedReason ? { blockedReason } : {}),
    };
  });

  app.post('/api/platforms/mcp/connect', (_request, reply) => {
    try {
      return { name: registerPlatformMcp(bridgeTarget()), connected: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/platforms/mcp/connect', (_request, reply) => {
    try {
      const removed = unregisterPlatformMcp(bridgeTarget());
      return { name: PLATFORM_MCP_ID, connected: false, removed };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Расход контура: период бюджета, всё время, дни.
   *
   * Читается из состояния панели и наружу не ходит НИ РАЗУ: остатка бюджета у
   * контура не спросить (подпись `budget-manual`), а поход по сети ради экрана
   * с цифрами нарушил бы инвариант «включённый контур молчит, пока его не
   * попросили». Перед чтением сбрасываем накопленный шлюзом хвост — иначе
   * человек, открывший карточку сразу после ответа, увидел бы вчерашнюю цифру.
   */
  app.get<{ Params: { id: string } }>('/api/platforms/:id/spend', (request, reply) => {
    try {
      const platform = requirePlatform(ctx.store, request.params.id);
      gateway.flushSpend();
      const record = ctx.store.getPlatformSpend()[platform.id] ?? emptySpend(platform.id);
      return spendInfo(platform, record) satisfies PlatformSpendInfo;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Снять отметку «бюджет исчерпан». Единственный способ её убрать: 402 —
   * последнее, что панель знает о чужом бюджете ТОЧНО, и гасить этот факт по
   * догадке («давно было», «счёт снова ниже бюджета») значило бы вернуть бодрое
   * «всё в порядке» контуру, который отказывает. Бюджет продлили в админке —
   * человек говорит об этом сам.
   */
  app.delete<{ Params: { id: string } }>('/api/platforms/:id/spend/exhausted', (request, reply) => {
    try {
      const platform = requirePlatform(ctx.store, request.params.id);
      const cleared = clearExhausted(ctx.store, platform.id);
      const record = ctx.store.getPlatformSpend()[platform.id] ?? emptySpend(platform.id);
      return { cleared, ...spendInfo(platform, record) } satisfies PlatformSpendInfo & {
        cleared: boolean;
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Ключ отдельным маршрутом: он не часть настройки и не должен ездить вместе с
   * ней в общем PATCH настроек. Пустая строка стирает сохранённый.
   */
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/platforms/:id/token',
    (request, reply) => {
      const body = request.body as { token?: unknown } | undefined;
      if (typeof body?.token !== 'string') {
        return fail(reply, invalidField('token', 'ключ должен быть строкой'));
      }
      try {
        const platform = requirePlatform(ctx.store, request.params.id);
        writeToken(appData(), platform.id, body.token.trim());
        return describePlatform(ctx.store, appData(), platform);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

/**
 * Отказ контура — ответ с кодом и человеческой причиной. Код берётся у самой
 * ошибки: клиент отличает «нет такого» (404) от «не заполнено поле» (400) по
 * коду, а не разбором текста.
 */
function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PlatformError) {
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      detail: error.detail,
      ...(error.messageCode ? { messageCode: error.messageCode, params: error.params } : {}),
    });
  }
  throw error;
}

/**
 * То же самое для маршрутов, которые ПИШУТ в чужие конфиги. Отказы здесь чужие
 * — их поднимает тот же код, что ведёт обычный раздел переменных окружения, — и
 * коды у них те же самые: раздел и контур правят один и тот же файл, и человек
 * не должен видеть два разных объяснения одной беды.
 */
function failWrite(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof EndpointApplyError) {
    const status = error.code === 'unknown_provider' ? 404 : 400;
    return reply.code(status).send({ code: error.code, message: error.message });
  }
  if (error instanceof EnvKeyNotEncodableError) {
    return reply.code(400).send({ code: 'invalid_draft', message: error.message });
  }
  if (error instanceof EnvKeyPreservedError) {
    return reply.code(409).send({ code: 'env_key_preserved', message: error.message });
  }
  if (error instanceof UnrecognizedFormatError) {
    return reply.code(422).send({
      code: 'format_unrecognized',
      message: 'Формат файла конфигурации не распознан — запись запрещена.',
    });
  }
  return fail(reply, error);
}

/** Список идентификаторов из тела запроса: не массив строк — отказ с именем поля. */
function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidField(field, 'ожидается список идентификаторов целей');
  }
  return value as string[];
}

/** Обязательная строка тела: пустая — тот же отказ, что и отсутствующая. */
function requireString(value: unknown, field: string, why: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidField(field, why);
  return value.trim();
}

/**
 * Необязательная строка. Пустая приравнивается к отсутствию: форма, приславшая
 * незаполненное поле сессии, иначе получила бы отказ контура вместо хода без
 * сессии.
 */
function optionalString(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalidField(field, 'ожидается строка');
  return value.trim();
}

/**
 * Переписка для агента: либо один вопрос (`message`), либо готовая история
 * (`messages`). Роль проверяется здесь, а не у контура: его отказ приезжает
 * по-английски и стоит похода по сети.
 */
function readMessages(
  body: { message?: unknown; messages?: unknown } | undefined,
): PlatformAgentMessage[] {
  if (typeof body?.message === 'string') {
    const text = body.message.trim();
    if (!text) throw invalidField('message', 'вопрос пустой');
    return [{ role: 'user', content: text }];
  }
  if (!Array.isArray(body?.messages)) {
    throw invalidField('message', 'нужен вопрос (message) или переписка (messages)');
  }
  return body.messages.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const role = item.role;
    const content = item.content;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw invalidField(`messages[${index}].role`, 'роль бывает user, assistant или system');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw invalidField(`messages[${index}].content`, 'сообщение пустое');
    }
    return { role, content };
  });
}
