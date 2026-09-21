import type { FastifyInstance, FastifyReply } from 'fastify';
import { checkCanonVersion } from '@agentdeck/contracts/portable-env';
import type { AgentEnvironment, EnvScope } from '@agentdeck/contracts/portable-env';
import { fidelityMark } from '@agentdeck/contracts/portable-fidelity';
import type {
  FidelityAnswer,
  FidelityMark,
  PreviousFidelity,
} from '@agentdeck/contracts/portable-fidelity';
import type { ProbeAnswer } from '@agentdeck/contracts/portable-probe';
import type {
  TransferApplyAnswer,
  TransferPlan,
  TransferRevertAnswer,
  TransferStateAnswer,
} from '@agentdeck/contracts/portable-transfer';
import type { EntityKind } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { getActiveProviderId, getProvider, isKnownProviderId } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { importEnvironment, hasImporter } from '../domains/portability/import/index.ts';
import { hasEmitter } from '../domains/portability/emit/index.ts';
import { buildFidelityReport } from '../domains/portability/fidelity-report.ts';
import {
  buildTransferPlan,
  rememberShownPlan,
  wasPlanShown,
  type PlannedTransfer,
} from '../domains/portability/plan.ts';
import {
  applyTransfer,
  changedSinceTransfer,
  revertTransfer,
  TransferBackupsDisabledError,
  TransferRolledBackError,
  TransferTargetNotWritableError,
} from '../domains/portability/apply.ts';
import { runProbe } from '../domains/portability/probe.ts';
import { fidelityReportKey } from '../lib/app-store/portability-fidelity.ts';
import { transferRecordKey } from '../lib/app-store/portability-transfer.ts';
import { codeOf } from '../lib/server-text.ts';
import { UnknownImportProviderError, type ImportState } from '../domains/portability/types.ts';
import { projectSupport, sectionTargets } from '../domains/portability/project.ts';

/**
 * Паспорт среды: что у человека НА САМОМ ДЕЛЕ настроено у одного CLI (П0.3).
 *
 * Только чтение: маршрут ничего не пишет, ничего не запускает и ни одного
 * чужого процесса не порождает. Ответ — канон целиком (`AgentEnvironment`), тот
 * же, с которым дальше будут работать матрица верности и перенос: второго
 * представления «для экрана» здесь намеренно нет, иначе экран и перенос начали
 * бы расходиться в том, что считать средой.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, которые важнее удобства:
 *
 *  1. **Значения секретов в ответе отсутствуют.** Канон их не носит вовсе —
 *     у `SecretItem` нет поля под значение (`portable-env.ts`), — так что
 *     утечка здесь невозможна не по договорённости, а по типу. Тест маршрута
 *     всё равно ищет значение-маркер во всём теле ответа: договор без проверки
 *     живёт до первого удобного поля.
 *  2. **Пустая среда — это 200 и названные пропуски**, а не 4xx. У человека
 *     законно может не быть ни одного хука; ответить ошибкой значило бы
 *     объявить поломкой его настройку.
 *  3. **Незнакомый провайдер — 400**, а не молчаливый откат на активного: откат
 *     показал бы чужой паспорт под запрошенным именем.
 *  4. **Уровень проекта требует НАЗВАННОГО проекта** (`project=<id>` из реестра
 *     панели), а у провайдера без проектных путей отвечает 400 с причиной.
 *     Молчаливый откат на дом выдал бы глобальный паспорт с пометкой «project»
 *     на каждой записи — ложь о происхождении (П2.5).
 */
export function registerPortabilityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { provider?: string; scope?: string; project?: string } }>(
    '/api/portability/passport',
    (request, reply) => {
      const resolved = resolveSource(
        ctx,
        request.query.provider,
        request.query.scope,
        request.query.project,
      );
      if (isRefusal(resolved)) return send(reply, resolved);

      try {
        return readEnvironment(ctx, resolved.source, resolved) satisfies AgentEnvironment;
      } catch (error) {
        // Реестр уже проверен `hasImporter`, но ловим и здесь: иначе гонка
        // «провайдер исчез из каталога между двумя строками» дала бы 500 без
        // причины вместо названного отказа.
        if (error instanceof UnknownImportProviderError) {
          return reply.code(400).send({
            error: 'importer_missing',
            message: error.message,
            messageCode: 'portability-importer-missing',
          });
        }
        // Любой другой отказ чтения — тоже названный, а не 500: испорченный
        // человеком `settings.json` поломкой сервера не является.
        return unreadableSource(reply, error);
      }
    },
  );

  /**
   * Отчёт верности: что будет с каждой записью паспорта у выбранной цели (П1.2).
   *
   * Отвечает ДО всякого применения — в этом весь смысл: строка «работает только
   * при запуске через панель» обязана быть видна человеку раньше, чем он нажмёт
   * «перенести», а не после.
   *
   * ТРИ РЕШЕНИЯ:
   *
   *  1. **Отчёт считается заново на каждом запросе.** Это чистая функция над
   *     паспортом и каталогом; отдать сохранённый значило бы показать вчерашнюю
   *     среду — файлы с тех пор могли смениться.
   *  2. **Сохранённый отчёт возвращается отдельным полем `previous`**, а не
   *     вместо нового: он отвечает на вопрос «что панель обещала в прошлый раз»
   *     и умеет признаться, что посчитан по другой версии канона.
   *  3. **Цель проверяется по каталогу, а не по наличию импортёра**: читать
   *     чужую среду для этого не нужно, а требовать импортёр значило бы скрыть
   *     цель, писать в которую панель уже умеет.
   */
  app.get<{
    Querystring: { provider?: string; target?: string; scope?: string; project?: string };
  }>('/api/portability/fidelity', (request, reply) => {
    const resolved = resolveTransfer(ctx, request.query, { needEmitter: false });
    if (isRefusal(resolved)) return send(reply, resolved);
    const { source, target, scope } = resolved;

    let env: AgentEnvironment;
    try {
      env = readEnvironment(ctx, source, resolved);
    } catch (error) {
      return unreadableSource(reply, error);
    }

    const key = fidelityReportKey(source.id, target.id, scope, resolved.projectId);
    const stored = ctx.store.getPortabilityFidelity()[key];
    // Разделы ЦЕЛИ на том же уровне, что и паспорт: на уровне проекта профиль
    // каталога описывал бы дом, и отчёт обещал бы «нативно» разделу, которого в
    // проекте нет (П2.5).
    const report = buildFidelityReport(
      env,
      target,
      new Date().toISOString(),
      sectionTargets(target, scope, {
        projectRoot: resolved.projectRoot,
        override: ctx.store.getSettings().claudeDirOverride,
      }),
    );
    // Сравнение — с тем, что лежало ДО расчёта: сохранение ниже перепишет
    // оттиск, только если обещание изменилось.
    const previous = previousOf(stored);
    ctx.store.savePortabilityFidelity(key, fidelityMark(report));

    return { report, previous } satisfies FidelityAnswer;
  });

  /**
   * План переноса: дифф КАЖДОГО файла цели до единой записи (П2.3).
   *
   * `POST`, хотя маршрут ничего не пишет, — по той же причине, что и у
   * предпросмотра одной записи: он выполняет настоящие операции адаптеров
   * (по временным копиям файлов), и это не запрос за ресурсом, который можно
   * закешировать или повторить браузером.
   *
   * Ответ несёт `fingerprint` — отпечаток показанного. Применение без него
   * отвечает 409: панель не пишет того, чего человеку не показала.
   */
  app.post<{ Body: { provider?: string; target?: string; scope?: string; project?: string } }>(
    '/api/portability/plan',
    (request, reply) => {
      const planned = planTransfer(ctx, request.body ?? {});
      if (isRefusal(planned)) return send(reply, planned);

      rememberShownPlan(planned.plan.fingerprint);
      return planned.plan satisfies TransferPlan;
    },
  );

  /**
   * Применение плана — единственный пишущий маршрут переноса.
   *
   * План строится ЗАНОВО и применяются правки этого свежего плана, а не
   * присланные клиентом: на проводе едет описание, а не замыкания, и принимать
   * «что писать» от клиента значило бы открыть запись в любой файл по его
   * выбору. Отпечаток при этом сверяется дважды — показывали ли план вообще
   * (`wasPlanShown`) и тот ли это план, что сейчас пересчитан.
   */
  app.post<{
    Body: {
      provider?: string;
      target?: string;
      scope?: string;
      project?: string;
      fingerprint?: string;
    };
  }>('/api/portability/apply', (request, reply) => {
    const body = request.body ?? {};
    const planned = planTransfer(ctx, body);
    if (isRefusal(planned)) return send(reply, planned);
    const { plan, writes } = planned;

    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
    if (!fingerprint || !wasPlanShown(fingerprint)) {
      return reply.code(409).send({
        error: 'plan_not_shown',
        message: 'Сначала предпросмотр: панель не пишет то, чего вам не показала.',
        messageCode: 'portability-plan-not-shown',
      });
    }
    if (fingerprint !== plan.fingerprint) {
      // Файлы цели или источника изменились между показом и нажатием. Свежий
      // план уходит тем же ответом: иначе человеку пришлось бы догадываться,
      // что именно разошлось.
      return reply.code(409).send({
        error: 'plan_stale',
        message: 'С момента предпросмотра файлы изменились — посмотрите план заново.',
        messageCode: 'portability-plan-stale',
        plan,
      });
    }

    try {
      const files = applyTransfer(plan.target, plan.root, writes, ctx.backupDir);
      const record = {
        source: plan.source,
        target: plan.target,
        scope: plan.scope,
        appliedAt: new Date().toISOString(),
        fingerprint: plan.fingerprint,
        files,
      };
      ctx.store.savePortabilityTransfer(
        transferRecordKey(plan.source, plan.target, plan.scope, planned.projectId),
        record,
      );
      return { record, entries: plan.entries } satisfies TransferApplyAnswer;
    } catch (error) {
      if (error instanceof TransferBackupsDisabledError)
        return reply
          .code(409)
          .send({ error: 'backups_off', message: error.message, ...codeOf(error) });
      if (error instanceof TransferTargetNotWritableError)
        return reply
          .code(409)
          .send({ error: 'target_not_writable', message: error.message, ...codeOf(error) });
      if (error instanceof TransferRolledBackError) {
        // Причина провала остаётся в журнале: она цитирует путь и текст чужой
        // файловой ошибки, а наружу идёт код и имя файла.
        reply.log.warn({ err: error }, 'portability: перенос откачен');
        return reply.code(500).send({
          error: error.rolledBack ? 'apply_rolled_back' : 'apply_rollback_failed',
          message: error.message,
          filePath: error.filePath,
          ...codeOf(error),
        });
      }
      throw error;
    }
  });

  /**
   * Приёмочная проба: прогноз становится измерением (П2.4).
   *
   * `POST`, потому что маршрут ЗАПУСКАЕТ чужой процесс — это действие, а не
   * запрос за ресурсом, и повторять его браузером по своей воле никто не должен.
   *
   * Дом человека проба не трогает ни при каком исходе: она строит временный,
   * кладёт туда шесть своих записей теми же эмиттерами и удаляет его целиком.
   * Поэтому источник переноса маршруту не нужен вовсе — он спрашивает про
   * механизмы ЦЕЛИ, и подставлять сюда паспорт человека было бы лишним чтением
   * его файлов ради ответа, который от них не зависит.
   */
  app.post<{ Body: { target?: string; scope?: string } }>(
    '/api/portability/probe',
    async (request, reply) => {
      const body = request.body ?? {};
      const targetId = body.target ?? '';
      if (!isKnownProviderId(targetId)) return send(reply, unknownTarget());

      const scope = scopeOf(body.scope);
      if (!scope)
        return send(
          reply,
          refuse(
            400,
            'bad_request',
            'Уровень пробы — «global» или «project».',
            'portability-scope-unknown',
          ),
        );

      const report = await runProbe({ target: getProvider(targetId), scope });
      return { report } satisfies ProbeAnswer;
    },
  );

  /**
   * След последнего переноса к этой цели: с чем страница открывается (П2.3).
   *
   * Только чтение — ни одного байта на диск. Существует ради кнопки отмены:
   * держи панель след в памяти вкладки, человек после перезагрузки страницы
   * увидел бы перенесённую среду и ни одного способа её вернуть.
   *
   * Следа нет — это 200 и `record: null`, а не 404: «панель сюда не переносила»
   * — законный и частый ответ, и отвечать на него ошибкой значило бы объявить
   * поломкой обычное состояние экрана. У `POST /revert` тот же случай остаётся
   * 404 по другой причине: там человек ПРОСИТ отменить, и молчаливое «ничего не
   * сделано» он прочитал бы как «отменено».
   */
  app.get<{
    Querystring: { provider?: string; target?: string; scope?: string; project?: string };
  }>('/api/portability/transfer', (request, reply) => {
    const resolved = resolveTransfer(ctx, request.query, { needEmitter: false });
    if (isRefusal(resolved)) return send(reply, resolved);
    const { source, target, scope } = resolved;

    const record = ctx.store.getPortabilityTransfer(
      transferRecordKey(source.id, target.id, scope, resolved.projectId),
    );
    return {
      record: record ?? null,
      changedSince: record ? changedSinceTransfer(record) : [],
    } satisfies TransferStateAnswer;
  });

  /**
   * Отмена всего переноса — кнопкой, а не только при провале.
   *
   * Без неё человек не нажмёт и первую кнопку: цена ошибки для него неизвестна.
   * Файлы, которые он правил уже ПОСЛЕ переноса, возвращаются списком и НЕ
   * трогаются, пока он не назовёт их сам в `confirm`: его правка новее нашей
   * записи, и «отменить перенос» не означает «стереть всё, что было потом».
   */
  app.post<{
    Body: {
      provider?: string;
      target?: string;
      scope?: string;
      project?: string;
      confirm?: unknown;
    };
  }>('/api/portability/revert', (request, reply) => {
    const body = request.body ?? {};
    // Эмиттер здесь не нужен: возврат идёт по следу с путями и копиями, а не
    // по плану. Цель всё равно обязана быть названной — след ищется по паре.
    const resolved = resolveTransfer(ctx, body, { needEmitter: false });
    if (isRefusal(resolved)) return send(reply, resolved);
    const { source, target, scope } = resolved;

    const key = transferRecordKey(source.id, target.id, scope, resolved.projectId);
    const record = ctx.store.getPortabilityTransfer(key);
    if (!record) {
      return reply.code(404).send({
        error: 'transfer_not_found',
        message: 'Отменять нечего: переноса к этой цели панель не делала.',
        messageCode: 'portability-transfer-not-found',
      });
    }

    const confirm = Array.isArray(body.confirm)
      ? body.confirm.filter((value): value is string => typeof value === 'string')
      : [];
    const answer = revertTransfer(record, confirm);

    if (answer.record) ctx.store.savePortabilityTransfer(key, answer.record);
    else ctx.store.forgetPortabilityTransfer(key);

    return answer satisfies TransferRevertAnswer;
  });
}

/** Источник, цель и уровень — всё, что общего у трёх шагов переноса. */
interface ResolvedTransfer extends ResolvedLevel {
  source: ConfigProvider;
  target: ConfigProvider;
}

/**
 * Уровень, разрешённый до конца: при `project` — каталог проекта из РЕЕСТРА
 * панели и его идентификатор.
 *
 * Сырой путь с провода сюда не попадает ни при каких условиях: корень проекта
 * задаёт запись реестра, которую человек завёл сам. Принять путь от клиента
 * значило бы позволить ему назвать любой каталог на диске целью записи, и
 * проверка `isInsideProject` внутри резолвера ничем бы не помогла — она
 * стережёт границы НАЗВАННОГО корня, а не его выбор.
 */
interface ResolvedLevel {
  scope: EnvScope;
  projectRoot?: string;
  projectId?: string;
}

/**
 * Названный отказ: код ответа и тело. Отдельным значением, а не немедленной
 * отправкой, потому что проверок несколько и живут они в общей функции — вернуть
 * отказ обязан тот же обработчик, который знает, что за ним стоит.
 */
interface Refusal {
  status: number;
  body: { error: string; message: string; messageCode: string };
}

function isRefusal(value: object): value is Refusal {
  return 'status' in value && 'body' in value;
}

function send(reply: FastifyReply, refusal: Refusal): FastifyReply {
  return reply.code(refusal.status).send(refusal.body);
}

function refuse(status: number, error: string, message: string, messageCode: string): Refusal {
  return { status, body: { error, message, messageCode } };
}

/**
 * Цель не названа или незнакома. Отдельной функцией, а не строкой в двух
 * местах: проба и перенос обязаны отвечать на один и тот же промах одинаково —
 * человек читает один экран, а не два маршрута.
 */
function unknownTarget(): Refusal {
  return refuse(
    400,
    'unknown_target',
    'Такой цели переноса панель не знает.',
    'portability-target-unknown',
  );
}

/**
 * Источник и уровень. Провайдер не назван — активный: страница открывается с
 * тем, кем человек сейчас работает, и ради первого взгляда выбирать никого не
 * приходится.
 */
function resolveSource(
  ctx: ServerContext,
  provider: string | undefined,
  scope: string | undefined,
  project: string | undefined,
): ({ source: ConfigProvider } & ResolvedLevel) | Refusal {
  const providerId = provider || getActiveProviderId(ctx.store);

  if (!isKnownProviderId(providerId))
    return refuse(
      400,
      'unknown_provider',
      'Такого провайдера панель не знает.',
      'provider-unknown-to-panel',
    );

  // Импортёра нет — сказать об этом прямо. Отдать пустой паспорт значило бы
  // соврать «среда пуста» про CLI, читать который панель не умеет (§5.4).
  if (!hasImporter(providerId))
    return refuse(
      400,
      'importer_missing',
      'Панель пока не умеет читать среду этого CLI.',
      'portability-importer-missing',
    );

  const level = scopeOf(scope);
  if (!level)
    return refuse(
      400,
      'bad_request',
      'Уровень паспорта — «global» или «project».',
      'portability-scope-unknown',
    );

  const source = getProvider(providerId);
  if (level === 'global') return { source, scope: level };

  // Уровень проекта без проекта — не «возьмём активный» и не «возьмём дом»:
  // первое молча ответило бы про чужой репозиторий, второе выдало бы глобальную
  // среду за проектную.
  if (!project)
    return refuse(
      400,
      'project_required',
      'Уровень проекта требует названного проекта.',
      'portability-project-required',
    );

  const known = ctx.store.getProject(project);
  if (!known)
    return refuse(
      400,
      'project_unknown',
      'Такого проекта в панели нет.',
      'portability-project-unknown',
    );

  // Уровня проекта у провайдера может не быть вовсе — и тогда отказ называет
  // причину, а не подставляет домашние пути (П2.5, критерий 2).
  const support = projectSupport(source);
  if (!support.supported)
    return refuse(
      400,
      'project_unsupported',
      support.why ?? 'Уровень проекта у этого CLI не задокументирован.',
      'portability-project-unsupported',
    );

  return { source, scope: level, projectRoot: known.path, projectId: known.id };
}

/** Источник, цель и уровень. Цель обязана быть названа: «куда» по умолчанию не бывает. */
function resolveTransfer(
  ctx: ServerContext,
  input: { provider?: string; target?: string; scope?: string; project?: string },
  options: { needEmitter: boolean },
): ResolvedTransfer | Refusal {
  const base = resolveSource(ctx, input.provider, input.scope, input.project);
  if (isRefusal(base)) return base;

  // Молчаливая подстановка активного провайдера дала бы отчёт «всё нативно» на
  // вопрос, которого человек не задавал.
  const targetId = input.target ?? '';
  if (!isKnownProviderId(targetId)) return unknownTarget();

  if (options.needEmitter && !hasEmitter(targetId))
    return refuse(
      400,
      'emitter_missing',
      'Панель пока не умеет писать среду этого CLI.',
      'portability-emitter-missing',
    );

  const target = getProvider(targetId);
  // Уровень проверяется у ОБЕИХ сторон: читать проект у источника и писать его
  // в дом цели — тот самый «сделаем как глобальный», который критерий 2
  // запрещает. Проверка источника уже прошла в `resolveSource`.
  const support = projectSupport(target);
  if (base.scope === 'project' && !support.supported)
    return refuse(
      400,
      'project_unsupported',
      support.why ?? 'Уровень проекта у этого CLI не задокументирован.',
      'portability-project-unsupported',
    );

  const { source, ...level } = base;
  return { source, target, ...level };
}

/**
 * Свежий план: и для показа, и для применения. Одна функция на оба шага —
 * применение обязано работать ровно с тем, что считает предпросмотр, и второй
 * сборки плана в коде быть не должно.
 */
function planTransfer(
  ctx: ServerContext,
  input: { provider?: string; target?: string; scope?: string; project?: string },
): (PlannedTransfer & { projectId?: string }) | Refusal {
  const resolved = resolveTransfer(ctx, input, { needEmitter: true });
  if (isRefusal(resolved)) return resolved;
  const { source, target, scope } = resolved;

  let env: AgentEnvironment;
  try {
    env = readEnvironment(ctx, source, resolved);
  } catch {
    return refuse(
      400,
      'source_not_readable',
      'Файлы этого CLI не читаются: проверьте, что его настройки не испорчены.',
      'portability-source-not-readable',
    );
  }

  return {
    ...buildTransferPlan(
      env,
      target,
      {
        scope,
        projectRoot: resolved.projectRoot,
        override: ctx.store.getSettings().claudeDirOverride,
      },
      new Date().toISOString(),
    ),
    // След переноса ищется по паре «источник → цель» И по проекту: план о
    // проекте знает корень, а ключ состояния — идентификатор записи реестра.
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
  };
}

/** Чтение среды источника — одинаковое у всех четырёх маршрутов. */
function readEnvironment(
  ctx: ServerContext,
  source: ConfigProvider,
  level: ResolvedLevel,
): AgentEnvironment {
  return importEnvironment({
    provider: source,
    scope: level.scope,
    projectRoot: level.projectRoot,
    // Ручной каталог уважает только Claude; остальным он и не передаётся
    // дальше их собственных путей.
    override: ctx.store.getSettings().claudeDirOverride,
    state: panelState(ctx),
  });
}

function previousOf(stored: FidelityMark | undefined): PreviousFidelity | null {
  if (!stored) return null;
  return {
    computedAt: stored.computedAt,
    canonVersion: stored.canonVersion,
    summary: stored.summary,
    onlyThroughPanel: stored.onlyThroughPanel,
    readable: checkCanonVersion(stored.canonVersion).readable,
  };
}

/**
 * Источник прочитать не удалось — НАЗВАННЫЙ отказ, а не 500 с текстом разборщика.
 *
 * Fail-closed (инвариант 3) означает 4xx с кодом сообщения: один пропущенный
 * запятой символ в `settings.json` человека — это не поломка сервера, и ответ
 * обязан называть причину так, чтобы её можно было показать на экране.
 *
 * Текст ошибки в тело НЕ кладётся намеренно. `JSON.parse` у файла, который
 * вообще не JSON, отвечает `Unexpected token 'x', "…" is not valid JSON` — то
 * есть ЦИТИРУЕТ начало файла, а в `settings.json` рядом живут ключи API. Причина
 * остаётся в логе сервера, наружу идёт код.
 */
function unreadableSource(reply: FastifyReply, error: unknown): FastifyReply {
  reply.log.warn({ err: error }, 'portability: источник не прочитан');
  return reply.code(400).send({
    error: 'source_not_readable',
    message: 'Файлы этого CLI не читаются: проверьте, что его настройки не испорчены.',
    messageCode: 'portability-source-not-readable',
  });
}

/** Уровень из запроса; не назван — дом человека. Чужое значение отвергается, а не подменяется. */
function scopeOf(raw: string | undefined): EnvScope | undefined {
  if (!raw) return 'global';
  return raw === 'global' || raw === 'project' ? raw : undefined;
}

/**
 * Отметки панели «выключено» — только для СВОЕГО дома: выключенный скилл лежит
 * в `skills/.disabled/`, а выключенное правило отмечено в состоянии панели, и
 * без этих отметок паспорт назвал бы действующим то, что не действует.
 *
 * Обёртка, а не сам `ctx.store`: импортёр получает ровно один метод чтения и ни
 * одного пишущего — снятие паспорта не имеет права трогать состояние панели.
 */
function panelState(ctx: ServerContext): ImportState {
  return {
    isDisabled: (kind, id, legacyId) => ctx.store.isDisabled(kind as EntityKind, id, legacyId),
  };
}
