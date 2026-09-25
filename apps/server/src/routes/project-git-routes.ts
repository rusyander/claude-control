import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ProjectGitResult,
  ProjectWorktreesInfo,
  ProjectWorktreesResult,
  WorktreeCopyState,
  WorktreeMirrorReport,
} from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { serverText } from '../lib/server-texts.ts';
import {
  GitError,
  addWorktree,
  bootstrapPlanFor,
  resolveProjectDelivery,
  checkoutBranch,
  commitAll,
  createBranch,
  listWorktrees,
  mirrorWorktree,
  pullChanges,
  pushBranch,
  readProjectGit,
  removeWorktree,
  type GitOutput,
} from '../domains/project-git.ts';
import { checkCopyReady, layoutForCwd } from '../domains/project-git/copy-readiness.ts';
import { copyProjectAccess } from '../domains/project-git/copy-access.ts';
import { checkProjectDir } from '../domains/projects.ts';
import { parseBody } from '../lib/request-body.ts';
import {
  gitBranchBodySchema,
  gitCheckoutBodySchema,
  gitCommitBodySchema,
  gitPathBodySchema,
  gitPullBodySchema,
  gitMirrorSettingsBodySchema,
  gitWorktreeAddBodySchema,
  gitWorktreeBootstrapBodySchema,
  gitWorktreeMirrorBodySchema,
  splitSettingsBodySchema,
  gitWorktreeRemoveBodySchema,
} from '@agentdeck/contracts/request-bodies';
import { codeOf } from '../lib/server-text.ts';

/**
 * Ровно та часть реестра прогонов, которая нужна маршрутам git: где сейчас
 * работают агенты. Структурный тип, а не сам класс, — тесту достаточно отдать
 * список путей, поднимать реестр целиком незачем.
 *
 * `isRunning` здесь обязателен: `active()` перечисляет ещё и прогоны, ЗАКОНЧИВШИЕСЯ
 * минуту назад (буфер догона при переподключении вкладки), а для «в копии работает
 * агент» такой прогон — уже неправда.
 */
export interface ActiveRuns {
  active(): { chatId: string; projectPath?: string }[];
  isRunning(chatId: string): boolean;
}

/**
 * Маршруты git выбранного проекта: состояние, переключение ветки, создание
 * ветки, коммит, подтягивание чужих коммитов.
 *
 * Чтение свободно и всегда отвечает 200 — даже «это не репозиторий» (`isRepo:
 * false`) и «git сломан» (`error`) — это ответ, а не ошибка запроса: клиенту
 * надо решить, показывать ли пульт. А вот любая ЗАПИСЬ, которая не удалась,
 * отвечает 400 с текстом самого git: подменять его формулировку своей — значит
 * прятать от пользователя то единственное, что объясняет отказ.
 *
 * Каталог приходит путём, а не идентификатором реестра, и это осознанно: вкладку
 * проекта можно открыть на любой папке, выбранной в проводнике панели, — она в
 * реестре не числится, а git у неё должен работать. Тот же уговор у рабочего
 * каталога чата. Общего с реестром здесь одно, и этого достаточно: путь проходит
 * через ту же проверку `checkProjectDir`, что и запись в реестр, и дальше в git
 * уходит уже нормализованным.
 *
 * Контекст сервера здесь не нужен — работаем с путём из запроса, — но параметр
 * объявлен: под `RouteRegistrar` подходят все модули маршрутов без исключений.
 *
 * Третьим параметром приходит реестр прогонов, и ровно за одним: удалить
 * рабочую копию, в которой прямо сейчас работает агент, нельзя. Проверка стоит
 * здесь, а не в домене git: домен не знает и не должен знать о прогонах, а гейт
 * на маршруте закрывает и панель, и телефон — оба ходят этим же путём.
 */
export function registerProjectGitRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  runs?: ActiveRuns,
  /** Настройки разделения сменились: очередь групп проекта добирает места. */
  onSplitSettings?: (projectPath: string) => void,
): void {
  /**
   * Каталог из запроса, пригодный для запуска git, или undefined с уже
   * отправленным 400. Проверка — общая с реестром проектов: абсолютный путь,
   * каталог существует и это действительно каталог. Наружу отдаётся `resolve`,
   * чтобы дальше по коду ходил один вид пути, а не тот, что прислал клиент.
   */
  const requirePath = (path: string | undefined, reply: FastifyReply): string | undefined => {
    const problem = checkProjectDir(String(path ?? ''));
    if (problem) {
      void reply.code(400).send({ message: problem });
      return undefined;
    }
    return resolve(path as string);
  };

  /**
   * Работает ли агент в этом каталоге. Пути сравниваем нормализованными — в
   * запросе, в реестре и у git они пишутся по-разному (слэши, регистр диска), а
   * промах здесь означал бы снос каталога из-под живого процесса.
   *
   * Проверяем ИМЕННО идущий прогон: перечень активных держит завершённые ещё
   * минуту (буфер догона), и без этой проверки копия, в которой агент только что
   * закончил, отказывалась бы удаляться со словами «остановите его» — а
   * останавливать уже некого.
   */
  const samePathAs = (a: string, b: string): boolean => {
    const norm = (value: string): string => {
      const text = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
      return process.platform === 'win32' ? text.toLowerCase() : text;
    };
    return norm(a) === norm(b);
  };

  const isBusy = (target: string): boolean => {
    const registry = runs;
    if (!registry) return false;
    const norm = (value: string): string => {
      const text = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
      return process.platform === 'win32' ? text.toLowerCase() : text;
    };
    const wanted = norm(target);
    return registry
      .active()
      .some(
        (run) =>
          run.projectPath && norm(run.projectPath) === wanted && registry.isRunning(run.chatId),
      );
  };

  /** Обёртка записи: результат = новое состояние + вывод git. */
  const write = async (
    path: string,
    reply: FastifyReply,
    action: () => Promise<GitOutput>,
  ): Promise<ProjectGitResult | FastifyReply> => {
    try {
      const result = await action();
      return { info: await readProjectGit(path), ...result };
    } catch (error) {
      if (error instanceof GitError)
        return reply.code(400).send({ message: error.message, ...codeOf(error) });
      throw error;
    }
  };

  /** Состояние репозитория: ветка, список веток, сколько файлов изменено. */
  app.get<{ Querystring: { path?: string } }>('/api/project-git', async (request, reply) => {
    const path = requirePath(request.query.path, reply);
    if (!path) return reply;
    return readProjectGit(path);
  });

  /** Переключиться на существующую локальную ветку. */
  app.post<{ Body: unknown }>('/api/project-git/checkout', async (request, reply) => {
    const body = parseBody(gitCheckoutBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return write(path, reply, () => checkoutBranch(path, body.branch));
  });

  /** Создать ветку от текущего HEAD и перейти на неё. */
  app.post<{ Body: unknown }>('/api/project-git/branch', async (request, reply) => {
    const body = parseBody(gitBranchBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return write(path, reply, () => createBranch(path, body.name));
  });

  /** Закоммитить все изменения рабочего дерева. */
  app.post<{ Body: unknown }>('/api/project-git/commit', async (request, reply) => {
    const body = parseBody(gitCommitBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return write(path, reply, () => commitAll(path, body.message));
  });

  /**
   * Подтянуть чужие коммиты. Без `branch` — обычный `git pull` в текущей ветке;
   * с `branch` — из соответствующей ветки удалённого. Пустая строка приходит от
   * селекта «текущая ветка», поэтому она равнозначна отсутствию поля.
   */
  app.post<{ Body: unknown }>('/api/project-git/pull', async (request, reply) => {
    const body = parseBody(gitPullBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return write(path, reply, () => pullChanges(path, body.branch));
  });

  /**
   * Отправить текущую ветку. Тела сверх пути нет намеренно: что отправлять,
   * решает состояние репозитория, а не запрос, — иначе кнопка «отправить»
   * умела бы больше, чем показывает.
   */
  app.post<{ Body: unknown }>('/api/project-git/push', async (request, reply) => {
    const body = parseBody(gitPathBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return write(path, reply, () => pushBranch(path));
  });

  /**
   * Список копий с состоянием бутстрапа и полнотой у каждой неосновной.
   *
   * Полнота считается здесь, а не отдельным запросом: отказ запуска агента
   * (`copy_not_ready`) опирается ровно на неё, и человек обязан видеть ту же
   * правду в карточке копии ДО того, как отправит сообщение. Сверка та же, что
   * стоит на горячем пути каждого прогона, — десяток обращений к файловой
   * системе и одно чтение `.claude.json`.
   */
  const listWithBootstrap = async (path: string): Promise<ProjectWorktreesInfo> => {
    const info = await listWorktrees(path);
    const mainDir = info.worktrees[0]?.path;
    return {
      ...info,
      worktrees: info.worktrees.map((item) => {
        if (item.isMain) return item;
        const bootstrap = ctx.worktreeBootstraps.status(item.path);
        return {
          ...item,
          ...(bootstrap ? { bootstrap } : {}),
          ...(mainDir ? { copy: copyState(mainDir, item.path) } : {}),
        };
      }),
    };
  };

  /** Полнота копии — ровно то, что скажет сверка перед запуском прогона. */
  const copyState = (mainDir: string, copyDir: string): WorktreeCopyState => {
    const { ready, gaps, access } = checkCopyReady({
      mainDir,
      copyDir,
      claudeJsonPath: ctx.location.paths.mcpConfig,
    });
    return { ready, gaps, access };
  };

  /**
   * Добор копии по кнопке: перенос локального слоя И запись доступа.
   *
   * Зеркало само записи доступа не заводит — её при создании копии делает
   * `addWorktree`. Кнопка на карточке обязана закрывать ту же дыру, иначе
   * «Добрать» чинит файлы и оставляет ровно ту причину отказа, из-за которой на
   * неё нажали. Отчёт дополняется тем же, что видит гейт прогона.
   */
  const finishCopy = (mainDir: string, copyDir: string, report: WorktreeMirrorReport): void => {
    const access = copyProjectAccess(ctx.location.paths.mcpConfig, mainDir, copyDir);
    report.access = {
      copied: access.copied,
      key: access.key,
      ...(access.reason ? { reason: access.reason } : {}),
    };
    report.gaps = copyState(mainDir, copyDir).gaps;
  };

  /**
   * Запустить бутстрап копии в фоне. Ответ на запрос его не ждёт: установка
   * идёт минуты, а карточка копии читает состояние из списка. Пустая команда
   * (ни настроенной, ни lock-файла) — тишина, не ошибка.
   */
  const startBootstrap = (path: string, copy: string): string | undefined => {
    const plan = bootstrapPlanFor(copy, ctx.store.getWorktreeMirror(path).bootstrap);
    if (!plan) return undefined;
    void ctx.worktreeBootstraps.run(copy, plan);
    return plan.summary;
  };

  /** Обёртка операций над копиями: результат = новый список + вывод git. */
  const worktreeWrite = async (
    path: string,
    reply: FastifyReply,
    action: () => Promise<GitOutput & { createdPath?: string; mirror?: WorktreeMirrorReport }>,
  ): Promise<ProjectWorktreesResult | FastifyReply> => {
    try {
      const { createdPath, mirror, ...output } = await action();
      return {
        info: await listWithBootstrap(path),
        ...output,
        ...(createdPath ? { createdPath } : {}),
        ...(mirror ? { mirror } : {}),
      };
    } catch (error) {
      if (error instanceof GitError)
        return reply.code(400).send({ message: error.message, ...codeOf(error) });
      throw error;
    }
  };

  /** Параллельные рабочие копии репозитория: где они и на какой ветке сейчас. */
  app.get<{ Querystring: { path?: string } }>(
    '/api/project-git/worktrees',
    async (request, reply) => {
      const path = requirePath(request.query.path, reply);
      if (!path) return reply;
      return listWithBootstrap(path);
    },
  );

  /** Завести копию под ветку: своя папка, своя ветка, общая история. */
  app.post<{ Body: unknown }>('/api/project-git/worktrees/add', async (request, reply) => {
    const body = parseBody(gitWorktreeAddBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return worktreeWrite(path, reply, async () => {
      const created = await addWorktree(
        path,
        body.name,
        ctx.store.getWorktreeMirror(path),
        undefined,
        ctx.location.paths.mcpConfig,
      );
      const command = startBootstrap(path, created.path);
      return {
        output: command
          ? `${created.output}\n${serverText('worktree-install-started', { command })}`
          : created.output,
        createdPath: created.path,
        ...(created.mirror ? { mirror: created.mirror } : {}),
      };
    });
  });

  /**
   * Повторить бутстрап существующей копии — после провала или смены команды.
   * Пока идёт прежний — 409: два установщика в одном каталоге ломают друг друга.
   */
  app.post<{ Body: unknown }>('/api/project-git/worktrees/bootstrap', async (request, reply) => {
    const body = parseBody(gitWorktreeBootstrapBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    const list = await listWorktrees(path);
    const target = list.worktrees.find(
      (item) => !item.isMain && samePathAs(item.path, body.worktreePath),
    );
    if (!target)
      return reply
        .code(404)
        .send({ message: 'Такой копии нет в списке git', messageCode: 'worktree-not-listed' });
    if (ctx.worktreeBootstraps.isRunning(target.path)) {
      return reply.code(409).send({
        message: 'Установка в этой копии уже идёт',
        messageCode: 'worktree-install-running',
      });
    }
    const command = startBootstrap(path, target.path);
    if (!command) {
      return reply.code(400).send({
        message: 'Команды нет: ни настроенной на проекте, ни lock-файла в корне копии',
        messageCode: 'worktree-install-no-command',
      });
    }
    return worktreeWrite(path, reply, async () => ({
      output: `Установка запущена: ${command}`,
      outputCode: 'worktree-install-started',
      outputParams: { command },
    }));
  });

  /** Полный лог последнего бутстрапа копии. */
  app.get<{ Querystring: { path?: string; worktreePath?: string } }>(
    '/api/project-git/worktrees/bootstrap-log',
    async (request, reply) => {
      const path = requirePath(request.query.path, reply);
      if (!path) return reply;
      const copy = String(request.query.worktreePath ?? '').trim();
      if (!copy)
        return reply
          .code(400)
          .send({ message: 'Нужен путь копии', messageCode: 'worktree-path-required' });
      return {
        log: ctx.worktreeBootstraps.log(copy),
        state: ctx.worktreeBootstraps.status(copy) ?? null,
      };
    },
  );

  /**
   * Повторно перенести локальный слой в уже существующую копию — после того,
   * как человек дописал шаблоны или поправил `.mcp.json` в основной копии.
   * Переносится только то, что в копии старее; её собственные правки не
   * затираются.
   */
  app.post<{ Body: unknown }>('/api/project-git/worktrees/mirror', async (request, reply) => {
    const body = parseBody(gitWorktreeMirrorBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return worktreeWrite(path, reply, async () => {
      const done = await mirrorWorktree(path, body.worktreePath, ctx.store.getWorktreeMirror(path));
      const list = await listWorktrees(path);
      const mainDir = list.worktrees[0]?.path;
      const target = list.worktrees.find(
        (item) => !item.isMain && samePathAs(item.path, body.worktreePath),
      );
      if (mainDir && target) finishCopy(mainDir, target.path, done.mirror);
      return done;
    });
  });

  /** Шаблоны зеркала на проекте: что человек дописал к встроенному списку. */
  app.get<{ Querystring: { path?: string } }>(
    '/api/project-git/mirror-settings',
    async (request, reply) => {
      const path = requirePath(request.query.path, reply);
      if (!path) return reply;
      return ctx.store.getWorktreeMirror(path);
    },
  );

  app.put<{ Body: unknown }>('/api/project-git/mirror-settings', async (request, reply) => {
    const body = parseBody(gitMirrorSettingsBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    return ctx.store.setWorktreeMirror(path, {
      include: body.include,
      exclude: body.exclude,
      ...(body.bootstrap !== undefined ? { bootstrap: body.bootstrap } : {}),
    });
  });

  /**
   * Разделение на проекте: доставка групп до MR и сколько их идёт разом. Копия
   * читает и пишет настройку своей основной копии — как строка доставки её чата
   * (`chatDeliveryFor`). По пути копии записи нет, и шапка чата группы
   * показывала коробочное «До MR: вкл» при выключенной доставке проекта (живой
   * прогон 25.09, O2).
   */
  const settingsDirOf = (path: string): string => layoutForCwd(path).mainDir ?? path;

  app.get<{ Querystring: { path?: string } }>(
    '/api/project-git/split-settings',
    async (request, reply) => {
      const path = requirePath(request.query.path, reply);
      if (!path) return reply;
      return resolveProjectDelivery(ctx.store, settingsDirOf(path)).view;
    },
  );

  app.put<{ Body: unknown }>('/api/project-git/split-settings', async (request, reply) => {
    const body = parseBody(splitSettingsBodySchema, request.body, reply);
    if (!body) return reply;
    const asked = requirePath(body.path, reply);
    if (!asked) return reply;
    const path = settingsDirOf(asked);
    ctx.store.setSplitSettings(path, {
      deliver: body.deliver,
      parallel: body.parallel,
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
    });
    onSplitSettings?.(path);
    return resolveProjectDelivery(ctx.store, path).view;
  });

  /**
   * Убрать копию. Отказ приходит раньше git в одном случае — в этой копии
   * работает агент: снести каталог из-под живого процесса значит потерять его
   * работу молча, а починить это потом нечем.
   */
  app.post<{ Body: unknown }>('/api/project-git/worktrees/remove', async (request, reply) => {
    const body = parseBody(gitWorktreeRemoveBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;
    const target = body.worktreePath;
    if (isBusy(target)) {
      return reply.code(409).send({
        message: 'В этой копии работает агент — остановите его и повторите',
        messageCode: 'worktree-agent-running',
      });
    }
    const force = body.force === true;
    return worktreeWrite(path, reply, () =>
      removeWorktree(path, target, force, ctx.location.paths.mcpConfig),
    );
  });
}
