import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { getProvider, isKnownProviderId } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { collectProviderFiles } from '../domains/env-transfer/collect.ts';
import {
  archiveFileName,
  buildEnvironmentArchive,
  parseEnvironmentArchive,
} from '../domains/env-transfer/archive.ts';
import { applyEnvironmentImport, planEnvironmentImport } from '../domains/env-transfer/import.ts';
import { reconcileActivePlatform } from '../domains/platform/activation.ts';
import { providerLocations } from '../domains/env-transfer/locations.ts';
import {
  buildPanelPlatforms,
  panelPlatformsChecklist,
  platformsChangingAddress,
  takePanelGateway,
  takePanelPlatforms,
} from '../domains/env-transfer/platforms.ts';
import {
  activeGatewaySettings,
  reconcileManagedProfiles,
} from '../domains/platform/apply/profile.ts';
import {
  forgetToken,
  readPlatforms,
  readToken,
  writePlatforms,
} from '../domains/platform/store.ts';
import { buildPanelPrompts, takePanelPrompts } from '../domains/env-transfer/prompts.ts';
import { PromptTooLongError } from '../domains/prompts/errors.ts';
import { exportPromptOverrides, savePrompt } from '../domains/prompts.ts';

/**
 * Перенос окружения: конфигурация ЛЮБОГО провайдера уезжает одним zip и
 * разворачивается на другой машине.
 *
 * Три свойства, ради которых это отдельный раздел, а не расширение бандла
 * конфигурации (тот умеет только правила + скиллы + хуки Claude):
 *   - работает для всех провайдеров по их же объявлениям в каталоге;
 *   - секреты не переносятся вовсе — вместо них чек-лист «что ввести руками»;
 *   - импорт сначала показывает план (новое / такое же / отличается), пишет
 *     только отмеченное и каждую перезапись кладёт в резервную копию.
 *
 * Файл архива пишется на диск в выбранный пользователем каталог, а не отдаётся
 * потоком в браузер: пользователю нужен путь, по которому архив можно найти,
 * а браузер положил бы его в «Загрузки» под своим именем.
 */
export function registerEnvTransferRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const override = (): string | undefined => ctx.store.getSettings().claudeDirOverride;

  /**
   * Контуры этой машины для архива. Ключа здесь нет и быть не может: берётся
   * настройка (`readPlatforms`), а ключ лежит отдельно, в шифрохранилище.
   * Порт шлюза — ДОСТАВШИЙСЯ, иначе на новой машине оказался бы адрес, по
   * которому и на прежней никто не отвечал.
   */
  const panelSection = () =>
    buildPanelPlatforms(readPlatforms(ctx.store), activeGatewaySettings(ctx.store));

  /**
   * Правки промптов этой машины для архива. Встроенных текстов здесь нет: они
   * приезжают вместе с панелью, и везти их копию значило бы перекрыть на новой
   * машине её собственный встроенный текст (`env-transfer/prompts.ts`).
   */
  const promptSection = () => buildPanelPrompts(exportPromptOverrides(ctx.location.paths.appData));

  /** Контекст этой машины для плана: с чем сравнивать и что уже есть. */
  const panelContext = () => ({
    current: readPlatforms(ctx.store),
    hasToken: (id: string) => Boolean(readToken(ctx.location.paths.appData, id)),
    prompts: exportPromptOverrides(ctx.location.paths.appData),
  });

  const requireProvider = (id: unknown, reply: FastifyReply): ConfigProvider | undefined => {
    if (typeof id !== 'string' || !isKnownProviderId(id)) {
      void reply.code(400).send({
        error: 'unknown_provider',
        message: 'Не указан известный провайдер.',
      });
      return undefined;
    }
    return getProvider(id);
  };

  /**
   * Отказ разворота. Архив и панель ломаются по-разному, и называть это одним
   * словом нельзя: «архив повреждён» о неудачной записи в состояние отправляет
   * человека искать новый zip вместо настоящей причины — заблокированного файла,
   * полного диска, сбоя сверки профилей.
   */
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    const message = error instanceof Error ? error.message : String(error);
    const badArchive = (error as { code?: string }).code === 'invalid_archive';
    return badArchive
      ? reply.code(400).send({ error: 'invalid_archive', message })
      : reply.code(500).send({ error: 'apply_failed', message });
  };

  /** Что попадёт в архив — до выбора папки, чтобы пользователь видел объём и чек-лист. */
  app.get<{ Querystring: { provider?: string } }>('/api/env-transfer/preview', (request, reply) => {
    const provider = requireProvider(request.query.provider, reply);
    if (!provider) return reply;

    const collected = collectProviderFiles(provider, override());
    const platforms = readPlatforms(ctx.store);
    return {
      provider: { id: provider.id, name: provider.name },
      // Контуры показываются ДО выбора папки: человек должен видеть, что его
      // корпоративная настройка уедет вместе с конфигурацией CLI, и увидеть
      // строку «ключ вводится заново» раньше, чем нажмёт «собрать».
      platforms: platforms.map((platform) => ({
        id: platform.id,
        title: platform.title,
        baseUrl: platform.baseUrl,
      })),
      locations: providerLocations(provider, override()).map((location) => ({
        index: location.index,
        kind: location.kind,
        role: location.role,
        path: location.path,
        exists: existsSync(location.path),
      })),
      files: collected.files.length,
      bytes: collected.totalBytes,
      skipped: collected.skipped,
      checklist: [...collected.checklist, ...panelPlatformsChecklist(platforms)],
    };
  });

  app.post<{ Body: { provider?: string; targetDir?: string; exportedAt?: string } }>(
    '/api/env-transfer/export',
    (request, reply) => {
      const body = request.body ?? {};
      const provider = requireProvider(body.provider, reply);
      if (!provider) return reply;

      const targetDir = body.targetDir;
      if (typeof targetDir !== 'string' || !targetDir || !isAbsolute(targetDir)) {
        return reply
          .code(400)
          .send({ error: 'invalid_target', message: 'Нужен абсолютный путь к папке.' });
      }
      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        return reply
          .code(400)
          .send({ error: 'invalid_target', message: 'Такой папки нет на диске.' });
      }

      const exportedAt = body.exportedAt?.trim() || new Date().toISOString();
      try {
        const built = buildEnvironmentArchive(
          provider,
          exportedAt,
          override(),
          panelSection(),
          promptSection(),
        );
        const path = uniquePath(targetDir, archiveFileName(provider.id, exportedAt));
        writeFileSync(path, built.zip);

        return {
          ok: true,
          path,
          bytes: built.zip.length,
          files: built.manifest.entries.length,
          platforms: built.manifest.panel?.platforms.length ?? 0,
          prompts: built.manifest.panelPrompts?.prompts.length ?? 0,
          skipped: built.manifest.skipped,
          checklist: built.manifest.checklist,
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Body: { provider?: string; archivePath?: string } }>(
    '/api/env-transfer/import/plan',
    (request, reply) => {
      const body = request.body ?? {};
      const provider = requireProvider(body.provider, reply);
      if (!provider) return reply;

      const zip = readArchive(body.archivePath, reply);
      if (!zip) return reply;

      try {
        return planEnvironmentImport(
          parseEnvironmentArchive(zip),
          provider,
          override(),
          panelContext(),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      provider?: string;
      archivePath?: string;
      selection?: unknown;
      platformSelection?: unknown;
      promptSelection?: unknown;
      applyGateway?: unknown;
    };
  }>('/api/env-transfer/import/apply', (request, reply) => {
    const body = request.body ?? {};
    const provider = requireProvider(body.provider, reply);
    if (!provider) return reply;

    const selection = stringList(body.selection);
    const platformSelection = stringList(body.platformSelection);
    const promptSelection = stringList(body.promptSelection);
    // Настройка шлюза — такая же отметка, как файл и контур: её одну человек
    // вправе принять, ничего больше не трогая. Без неё в этой проверке кнопка на
    // экране была бы включена, а маршрут отвечал бы «не отмечено ни одной
    // записи» на прямо отмеченную запись.
    const applyGateway = body.applyGateway === true;
    if (
      selection.length === 0 &&
      platformSelection.length === 0 &&
      promptSelection.length === 0 &&
      !applyGateway
    ) {
      return reply
        .code(400)
        .send({ error: 'empty_selection', message: 'Не отмечено ни одной записи.' });
    }

    const zip = readArchive(body.archivePath, reply);
    if (!zip) return reply;

    try {
      const parsed = parseEnvironmentArchive(zip);
      // Файлы пишутся, только если их отметили: отдельный контур можно принять,
      // не трогая ни одного чужого конфига.
      const summary =
        selection.length > 0
          ? applyEnvironmentImport(parsed, provider, {
              selection,
              override: override(),
              backupDir: ctx.backupDir,
            })
          : { written: [], merged: [], skipped: [], backupPaths: [] };

      const platforms = applyPanelSection(parsed, platformSelection, applyGateway);
      const prompts = applyPromptSection(parsed, promptSelection);
      return { ok: true, needsRestart: true, summary, platforms, prompts };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Записывает отмеченные контуры и, если попросили, настройку шлюза.
   *
   * Ключ не пишется и взяться ему неоткуда: в архиве его нет. Поэтому контур,
   * приехавший включённым, останется без ключа — и `requireConnected` откажет
   * честным «не подключён», а не уйдёт наружу с пустым заголовком.
   *
   * А контуру, которому разворот МЕНЯЕТ АДРЕС, ключ этой машины снимается вместе
   * со следом пробы (`platformsChangingAddress`). Иначе одна галочка отправляла
   * бы живой корпоративный ключ на адрес, приехавший в zip с чужой машины, и
   * показывала бы при этом зелёную пробу прежнего адреса. Расход остаётся: это
   * настоящие траты этой машины, и стирать их за человека панель не станет.
   *
   * Сверка управляемых профилей — обязательный хвост записи: без неё в списке
   * эндпоинтов не появилось бы профиля нового контура, и ассистент панели о нём
   * бы не узнал.
   */
  function applyPanelSection(
    parsed: ReturnType<typeof parseEnvironmentArchive>,
    selection: string[],
    applyGateway: boolean,
  ): { written: string[]; gateway: boolean; keysDropped: string[] } {
    if (selection.length === 0 && !applyGateway) {
      return { written: [], gateway: false, keysDropped: [] };
    }

    const data = parsed.manifest.panel
      ? parsed.files.get(parsed.manifest.panel.archivePath)
      : undefined;

    const incoming = takePanelPlatforms(data, selection);
    const keysDropped = platformsChangingAddress(readPlatforms(ctx.store), incoming);
    for (const id of keysDropped) {
      forgetToken(ctx.location.paths.appData, id);
      ctx.store.forgetPlatformHealth(id);
    }

    // Одной записью: половина применённой пачки — состояние, которого человек не
    // выбирал (`store.writePlatforms`).
    writePlatforms(ctx.store, incoming);
    const written = incoming.map((platform) => platform.id);
    // Архив принёс тумблеры ЧУЖОЙ машины, где активным был свой контур. Без
    // сведения включённых оказалось бы двое — здешний активный и приехавший, —
    // и шлюз обслуживал бы обоих, пока карточка приехавшего называет его
    // неактивным (инвариант 1). Здешний активный остаётся активным: архив
    // привозит настройки, а не решение о том, через что идёт работа.
    if (written.length > 0) reconcileActivePlatform(ctx.store);

    const gateway = applyGateway ? takePanelGateway(data) : undefined;
    if (gateway) ctx.store.updateSettings({ platformGateway: gateway });

    if (written.length > 0 || gateway) reconcileManagedProfiles(ctx.store);
    return { written, gateway: Boolean(gateway), keysDropped };
  }

  /**
   * Пишет отмеченные правки промптов. Встроенные тексты остаются нетронутыми —
   * не по договорённости, а потому, что писать в них некуда: они лежат файлами
   * репозитория, а сюда приезжает только слой правок.
   *
   * Неизвестный этой панели идентификатор отсеивается доменом (`takePanelPrompts`)
   * и в ответ не попадает: молча созданный файл правки для несуществующего
   * промпта никто бы не прочитал.
   */
  function applyPromptSection(
    parsed: ReturnType<typeof parseEnvironmentArchive>,
    selection: string[],
  ): { written: string[]; skipped: { id: string; reason: string }[] } {
    if (selection.length === 0) return { written: [], skipped: [] };

    const data = parsed.manifest.panelPrompts
      ? parsed.files.get(parsed.manifest.panelPrompts.archivePath)
      : undefined;

    const written: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const override of takePanelPrompts(data, selection)) {
      try {
        // Через тот же путь, что и правка руками: совпавший со встроенным текст
        // правкой не станет, а дата сохранения будет датой разворота, а не чужой
        // машины — здесь это правка появилась сегодня. Потолок длины держит тот
        // же путь, поэтому архив с гигантским промптом отказывается ОДНОЙ
        // правкой, а не роняет весь разворот.
        const record = savePrompt(
          ctx.location.paths.appData,
          override.id,
          override.text,
          undefined,
          ctx.backupDir,
        );
        // Текст, совпавший со встроенным ЭТОЙ панели, правкой не становится —
        // и записанным не называется: ответ говорит о том, что легло на диск.
        if (record.overridden) written.push(override.id);
      } catch (error) {
        if (!(error instanceof PromptTooLongError)) throw error;
        skipped.push({ id: override.id, reason: error.message });
      }
    }
    return { written, skipped };
  }

  /** Читает архив с диска. Путь приходит из обзора файловой системы панели. */
  function readArchive(path: unknown, reply: FastifyReply): Buffer | undefined {
    if (typeof path !== 'string' || !path || !isAbsolute(path)) {
      void reply
        .code(400)
        .send({ error: 'invalid_archive', message: 'Нужен абсолютный путь к архиву.' });
      return undefined;
    }
    try {
      if (!statSync(path).isFile()) throw new Error('не файл');
      return readFileSync(path);
    } catch {
      void reply.code(400).send({ error: 'invalid_archive', message: 'Архив недоступен.' });
      return undefined;
    }
  }
}

/** Список строк из тела запроса: всё остальное отбрасывается молча. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Свободное имя в папке: если такой архив уже есть, добавляем номер. */
function uniquePath(dir: string, fileName: string): string {
  const candidate = join(dir, fileName);
  if (!existsSync(candidate)) return candidate;

  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const next = join(dir, `${base}-${index}${extension}`);
    if (!existsSync(next)) return next;
  }
  throw Object.assign(new Error('В папке слишком много архивов с таким именем.'), {
    code: 'invalid_archive',
  });
}
