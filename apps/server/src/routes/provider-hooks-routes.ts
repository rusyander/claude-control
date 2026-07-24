import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderHooksTarget,
  readProviderHooksInfo,
  parseProviderHooksDraft,
  saveProviderHooks,
  type ProviderHooksTarget,
} from '../domains/provider-hooks.ts';
import { UnrecognizedFormatError } from '../lib/codex-toml.ts';

/**
 * Хуки НЕ-Claude провайдера (OPENCODE-3) — глобальный уровень.
 *
 * Claude сюда НЕ ходит: у него своя, принципиально другая модель хуков на
 * прежних маршрутах `/api/hooks` (события `PreToolUse`/`PostToolUse`, матчеры,
 * shell-команды) — регресс-ноль, тот раздел не тронут. Здесь — OpenCode: ключ
 * `experimental.hook` в `opencode.json`, два события, действия-argv.
 *
 * FAIL-CLOSED на каждом шаге:
 *  - провайдер без `hooksConfig`/`hooks=ready` (включая claude) → 400
 *    `section_unsupported`;
 *  - черновик не той формы (пустой `command`, не-строка в argv, повтор шаблона)
 *    → 400 `invalid_draft`, в файл ничего не пишется;
 *  - файл не разобран → GET отдаёт `readOnly:true`, PUT 422 `format_unrecognized`
 *    (файл остаётся байт-в-байт прежним);
 *  - черновик называет событие, форму которого панель не поняла → 422.
 */
export function registerProviderHooksRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела хуков.',
  } as const;

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message:
      'Хуки не прошли проверку: команда — непустой список непустых аргументов, шаблон файлов непустой и не повторяется, имена переменных окружения непустые и уникальные.',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  } as const;

  const requireTarget = (reply: FastifyReply): ProviderHooksTarget | undefined => {
    const target = resolveProviderHooksTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  app.get('/api/provider-hooks', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return readProviderHooksInfo(target);
  });

  app.put<{ Body: unknown }>('/api/provider-hooks', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const draft = parseProviderHooksDraft(request.body);
    if (!draft) return reply.code(400).send(INVALID_DRAFT);

    try {
      const backupPath = saveProviderHooks(target, draft, ctx.backupDir);
      return { ok: true as const, backupPath, needsRestart: true as const };
    } catch (error) {
      if (error instanceof UnrecognizedFormatError) {
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      }
      throw error;
    }
  });
}
