import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Project, ProviderProjectInstructions } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  providerProjectInfo,
  readProviderProjectInstructions,
  resolveProviderProjectTarget,
  writeProviderProjectInstructions,
  UnsafeProjectPathError,
  type ProviderProjectTarget,
} from '../domains/provider-projects.ts';
import {
  readProviderMcpServers,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  parseUniversalDraft,
  UnrecognizedFormatError,
} from '../domains/provider-mcp.ts';
import {
  readProviderEnvVars,
  saveProviderEnvVars,
  parseProviderEnvDraft,
  EnvKeyNotEncodableError,
} from '../domains/provider-env.ts';
import {
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  isCliOnlyGeminiApprovalMode,
  GEMINI_APPROVAL_MODES,
} from '../domains/provider-permissions.ts';
import {
  readProviderInstructionsInfo,
  parseProviderInstructionsDraft,
  saveProviderInstructionsEntries,
  readListedInstructionsFile,
  writeListedInstructionsFile,
  ListedFileNotEditableError,
} from '../domains/provider-instructions.ts';
import {
  readProviderRulesInfo,
  readProviderRule,
  parseProviderRuleDraft,
  saveProviderRule,
  deleteProviderRule,
  describeRuleError,
} from '../domains/provider-rules.ts';
import { checkProjectDir } from '../domains/projects.ts';

/**
 * Проектный уровень конфигурации у НЕ-Claude провайдеров (COMMON-2).
 *
 * Реестр проектов общий (`/api/projects` — раздел самой панели), а вот файлы
 * проекта у каждого провайдера свои. Claude обслуживается прежними маршрутами
 * `/api/projects/:id/{rules,mcp,permissions}` — они не тронуты (регресс-ноль);
 * здесь живёт универсальная ветка `/api/projects/:id/provider/*`.
 *
 * FAIL-CLOSED на каждом шаге:
 *  - провайдер без `projects=ready`/`projectConfig` (включая claude) → 400
 *    `section_unsupported`;
 *  - проект не в реестре → 404; каталог проекта исчез → 400 `invalid_project`;
 *  - раздела нет у этого провайдера (у Cursor нет проектных инструкций) → 400;
 *  - путь вышел бы за пределы проекта → 400 `unsafe_path` (запись не делается);
 *  - формат файла не распознан → чтение отдаёт `readOnly`, запись 422.
 */
export function registerProviderProjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет проектного уровня конфигурации.',
  } as const;

  const INSTRUCTIONS_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет проектного файла инструкций.',
  } as const;

  const INSTRUCTIONS_LIST_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера инструкции проекта не устроены списком ссылок.',
  } as const;

  const INVALID_LIST_DRAFT = {
    error: 'invalid_draft',
    message:
      'Список файлов не прошёл проверку: каждая запись должна быть непустой строкой без переводов строк.',
  } as const;

  const INSTRUCTIONS_RULES_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера правила проекта не устроены каталогом .mdc.',
  } as const;

  const INVALID_RULE_DRAFT = {
    error: 'invalid_draft',
    message:
      'Правило не прошло проверку: нужен путь внутри каталога правил и текстовое тело; description и globs — однострочные, alwaysApply — булево.',
  } as const;

  const MCP_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет проектного файла MCP-серверов.',
  } as const;

  const ENV_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет проектного файла переменных окружения.',
  } as const;

  const PERMISSIONS_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет проектного файла прав/аппрувов.',
  } as const;

  const INVALID_ENV_DRAFT = {
    error: 'invalid_draft',
    message: 'Набор переменных не прошёл проверку: у каждой нужны непустой ключ и значение.',
  } as const;

  const INVALID_PERMISSIONS_DRAFT = {
    error: 'invalid_draft',
    message: 'Значения прав не прошли проверку: они должны быть из допустимых наборов.',
  } as const;

  const MODE_CLI_ONLY = {
    error: 'mode_cli_only',
    message:
      'Режим «yolo» в settings.json записать нельзя: у Gemini он допустим только как флаг командной строки, а в файле настроек вызывает ошибку при запуске CLI. Запускайте его флагом `--yolo`.',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  } as const;

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message:
      'Черновик сервера не прошёл проверку: нужны имя, транспорт и команда (stdio) или адрес (http).',
  } as const;

  const done = (backupPath?: string): { ok: true; backupPath?: string; needsRestart: true } => ({
    ok: true,
    backupPath,
    needsRestart: true,
  });

  /**
   * Проектная цель активного провайдера по id записи реестра. Undefined означает,
   * что ответ уже отправлен (404/400) — маршрут просто возвращает reply.
   */
  const requireTarget = (id: string, reply: FastifyReply): ProviderProjectTarget | undefined => {
    const project: Project | undefined = ctx.store.getProject(id);
    if (!project) {
      void reply.code(404).send({ error: 'not_found', message: 'Проект не найден в реестре' });
      return undefined;
    }

    // Каталог мог быть удалён/переименован уже после добавления в реестр —
    // проверяем перед каждой операцией, а не только при добавлении.
    const problem = checkProjectDir(project.path);
    if (problem) {
      void reply.code(400).send({ error: 'invalid_project', message: problem });
      return undefined;
    }

    try {
      const target = resolveProviderProjectTarget(ctx.store, project.path);
      if (!target) {
        void reply.code(400).send(SECTION_UNSUPPORTED);
        return undefined;
      }
      return target;
    } catch (error) {
      if (error instanceof UnsafeProjectPathError) {
        void reply.code(400).send({ error: 'unsafe_path', message: error.message });
        return undefined;
      }
      throw error;
    }
  };

  // --- Что провайдер умеет на уровне этого проекта ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/provider', (request, reply) => {
    const target = requireTarget(request.params.id, reply);
    if (!target) return reply;
    return providerProjectInfo(target);
  });

  // --- Инструкции проекта: AGENTS.md / GEMINI.md в корне ---

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/provider/instructions',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructions) return reply.code(400).send(INSTRUCTIONS_UNSUPPORTED);

      const { content, exists } = readProviderProjectInstructions(target);
      return {
        content,
        exists,
        fileName: target.instructions.fileName,
        filePath: target.instructions.filePath,
        providerId: target.provider.id,
        providerName: target.provider.name,
      } satisfies ProviderProjectInstructions;
    },
  );

  app.put<{ Params: { id: string }; Body: { content?: unknown } }>(
    '/api/projects/:id/provider/instructions',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructions) return reply.code(400).send(INSTRUCTIONS_UNSUPPORTED);

      const content = (request.body ?? {}).content;
      // Как и у глобальных инструкций: пустая строка — осознанная очистка, всё
      // нестроковое — отказ, чтобы запрос без поля не затирал файл пустотой.
      if (typeof content !== 'string') {
        return reply.code(400).send({
          error: 'invalid_content',
          message: 'Поле content обязано быть строкой (пустая строка допустима).',
        });
      }

      return done(writeProviderProjectInstructions(target, content, ctx.backupDir));
    },
  );

  // --- Инструкции проекта СПИСКОМ ССЫЛОК: `read` в <проект>/.aider.conf.yml ---
  // Тот же домен, что и у глобального раздела (AIDER-1); отличие одно — корень
  // проекта задан, поэтому перечисленный файл за его пределами не открывается.

  /** Отказ по одной записи: «нет в списке» → 404, прочее (нет файла, бинарь) → 400. */
  const sendEntryError = (reply: FastifyReply, error: ListedFileNotEditableError): FastifyReply =>
    reply
      .code(error.reason === 'unlisted' ? 404 : 400)
      .send({ error: error.reason, message: error.message });

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/provider/instructions-list',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      return readProviderInstructionsInfo(target.instructionsList);
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/instructions-list',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      const entries = parseProviderInstructionsDraft(request.body);
      if (!entries) return reply.code(400).send(INVALID_LIST_DRAFT);

      try {
        return done(
          saveProviderInstructionsEntries(target.instructionsList, entries, ctx.backupDir),
        );
      } catch (error) {
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/instructions-list/file',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_LIST_DRAFT);

      try {
        return readListedInstructionsFile(target.instructionsList, raw);
      } catch (error) {
        if (error instanceof ListedFileNotEditableError) return sendEntryError(reply, error);
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { path?: unknown; content?: unknown } }>(
    '/api/projects/:id/provider/instructions-list/file',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      const body = request.body ?? {};
      const raw = body.path;
      const content = body.content;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_LIST_DRAFT);
      if (typeof content !== 'string') {
        return reply.code(400).send({
          error: 'invalid_content',
          message: 'Поле content обязано быть строкой (пустая строка допустима).',
        });
      }

      try {
        return done(
          writeListedInstructionsFile(target.instructionsList, raw, content, ctx.backupDir),
        );
      } catch (error) {
        if (error instanceof ListedFileNotEditableError) return sendEntryError(reply, error);
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  // --- Правила проекта КАТАЛОГОМ `.mdc`: `<проект>/.cursor/rules` (CURSOR-1) ---
  // Тот же домен, что и у глобального каталога; отличие одно — корень лежит в
  // проекте (и сам он уже проверен `resolveProjectFile` на выход за его пределы).

  /** Выполнить операцию домена правил, разложив её отказы в коды ответа. */
  const guardedRule = <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      const described = describeRuleError(error);
      if (!described) throw error;
      return reply.code(described.status).send(described.body);
    }
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/rules', (request, reply) => {
    const target = requireTarget(request.params.id, reply);
    if (!target) return reply;
    if (!target.instructionsRules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

    return readProviderRulesInfo(target.instructionsRules);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/rules/rule',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsRules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_RULE_DRAFT);

      return guardedRule(reply, () => readProviderRule(target.instructionsRules!, raw));
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/rules/rule',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsRules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

      const draft = parseProviderRuleDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_RULE_DRAFT);

      return guardedRule(reply, () => {
        const saved = saveProviderRule(target.instructionsRules!, draft, ctx.backupDir);
        return {
          ...done(saved.backupPath),
          path: saved.path,
          fullPath: saved.fullPath,
        };
      });
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/rules/rule',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsRules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_RULE_DRAFT);

      return guardedRule(reply, () => {
        const removed = deleteProviderRule(target.instructionsRules!, raw, ctx.backupDir);
        return { ...done(removed.backupPath), path: removed.path };
      });
    },
  );

  // --- MCP-серверы проекта: тот же универсальный субсет, файл в проекте ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/mcp', (request, reply) => {
    const target = requireTarget(request.params.id, reply);
    if (!target) return reply;
    if (!target.mcp) return reply.code(400).send(MCP_UNSUPPORTED);

    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      format: target.mcp.format,
      filePath: target.mcp.filePath,
      cliDetected: target.mcp.cliDetected,
    };

    try {
      return { ...base, servers: readProviderMcpServers(target.mcp), readOnly: false };
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение (пустой список) с пометкой.
      if (error instanceof UnrecognizedFormatError) {
        return { ...base, servers: [], readOnly: true, error: error.message };
      }
      throw error;
    }
  });

  /** Общая обёртка записи MCP: fail-closed на нераспознанном формате файла. */
  const writeMcp = (reply: FastifyReply, run: () => string | undefined): unknown => {
    try {
      return done(run());
    } catch (error) {
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  };

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/mcp',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.mcp) return reply.code(400).send(MCP_UNSUPPORTED);

      const draft = parseUniversalDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_DRAFT);

      return writeMcp(reply, () =>
        upsertProviderMcpServer(target.mcp!, null, draft, ctx.backupDir),
      );
    },
  );

  app.put<{ Params: { id: string; serverId: string }; Body: unknown }>(
    '/api/projects/:id/provider/mcp/:serverId',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.mcp) return reply.code(400).send(MCP_UNSUPPORTED);

      const draft = parseUniversalDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_DRAFT);

      return writeMcp(reply, () =>
        upsertProviderMcpServer(target.mcp!, request.params.serverId, draft, ctx.backupDir),
      );
    },
  );

  app.delete<{ Params: { id: string; serverId: string } }>(
    '/api/projects/:id/provider/mcp/:serverId',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.mcp) return reply.code(400).send(MCP_UNSUPPORTED);

      return writeMcp(reply, () =>
        deleteProviderMcpServer(target.mcp!, request.params.serverId, ctx.backupDir),
      );
    },
  );

  // --- Переменные окружения проекта: тот же адаптер, файл в проекте -----------

  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/env', (request, reply) => {
    const target = requireTarget(request.params.id, reply);
    if (!target) return reply;
    if (!target.env) return reply.code(400).send(ENV_UNSUPPORTED);

    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      format: target.env.format,
      filePath: target.env.filePath,
      cliDetected: target.env.cliDetected,
    };

    try {
      return { ...base, vars: readProviderEnvVars(target.env), readOnly: false };
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение (пустой список) с пометкой.
      if (error instanceof UnrecognizedFormatError) {
        return { ...base, vars: [], readOnly: true, error: error.message };
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/env',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.env) return reply.code(400).send(ENV_UNSUPPORTED);

      const vars = parseProviderEnvDraft(request.body);
      if (!vars) return reply.code(400).send(INVALID_ENV_DRAFT);

      try {
        return done(saveProviderEnvVars(target.env, vars, ctx.backupDir));
      } catch (error) {
        // Имя переменной непредставимо в формате провайдера — ошибка ввода (400),
        // а не сломанный файл: сообщение объясняет, что именно не так.
        if (error instanceof EnvKeyNotEncodableError) {
          return reply.code(400).send({ error: 'invalid_draft', message: error.message });
        }
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  // --- Права/аппрувы проекта: тот же адаптер, файл в проекте ------------------

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/provider/permissions',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.permissions) return reply.code(400).send(PERMISSIONS_UNSUPPORTED);

      const base = {
        providerId: target.provider.id,
        providerName: target.provider.name,
        kind: 'gemini' as const,
        format: target.permissions.format,
        filePath: target.permissions.filePath,
        cliDetected: target.permissions.cliDetected,
        approvalModes: [...GEMINI_APPROVAL_MODES],
      };

      try {
        const values = readProviderPermissions(target.permissions);
        // Проектный уровень объявлен только для формата gemini-json; codex-модель
        // сюда не приходит, но проверяем явно — fail-closed вместо приведения типа.
        if (values.kind !== 'gemini') return reply.code(400).send(PERMISSIONS_UNSUPPORTED);
        return {
          ...base,
          approvalMode: values.approvalMode,
          coreTools: values.coreTools,
          excludeTools: values.excludeTools,
          usingDefaults: values.usingDefaults,
          readOnly: false,
        };
      } catch (error) {
        if (error instanceof UnrecognizedFormatError) {
          return {
            ...base,
            approvalMode: 'default' as const,
            coreTools: [],
            excludeTools: [],
            usingDefaults: true,
            readOnly: true,
            error: error.message,
          };
        }
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/permissions',
    (request, reply) => {
      const target = requireTarget(request.params.id, reply);
      if (!target) return reply;
      if (!target.permissions) return reply.code(400).send(PERMISSIONS_UNSUPPORTED);

      const draft = parseProviderPermissionsDraft(request.body, target.permissions.format);
      if (!draft) {
        // `yolo` отклоняем отдельным сообщением: у Gemini это режим только для
        // флага CLI, в settings.json он ломает запуск.
        if (
          target.permissions.format === 'gemini-json' &&
          isCliOnlyGeminiApprovalMode(request.body)
        ) {
          return reply.code(400).send(MODE_CLI_ONLY);
        }
        return reply.code(400).send(INVALID_PERMISSIONS_DRAFT);
      }

      try {
        return done(saveProviderPermissions(target.permissions, draft, ctx.backupDir));
      } catch (error) {
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
