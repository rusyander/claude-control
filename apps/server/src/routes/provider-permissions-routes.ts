import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderPermissionsTarget,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  isCliOnlyGeminiApprovalMode,
  buildProviderPermissionInfo,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from '../domains/provider-permissions.ts';

/**
 * Универсальный раздел прав/аппрувов для провайдеров Codex (TOML), Gemini
 * (settings.json) и OpenCode (opencode.json, ключ `permission`). Claude сюда НЕ
 * ходит: его права на собственных богатых роутах (settings.json allow/deny/ask) —
 * их не трогаем. Клиент выбирает набор роутов по активному провайдеру.
 *
 * Fail-closed: провайдер без `permissions=ready`/`permissionsConfig` → 400
 * `section_unsupported` (Claude/Cursor/Aider сюда попадают под этот отказ).
 * Значение вне enum → 400 `invalid_draft` (валидация ДО записи); отдельный случай
 * — режим `yolo` у Gemini: он допустим только как флаг CLI и ломает settings.json,
 * поэтому отвечаем 400 `mode_cli_only` с объяснением. Формат файла не распознан →
 * запись отвечает 422 `format_unrecognized`, чтение отдаёт `readOnly:true`.
 */
export function registerProviderPermissionsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела прав/аппрувов.',
  } as const;

  const INVALID_DRAFT = {
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

  const done = (backupPath?: string): { ok: true; backupPath?: string; needsRestart: true } => ({
    ok: true,
    backupPath,
    needsRestart: true,
  });

  const requireTarget = (reply: FastifyReply): ProviderPermissionsTarget | undefined => {
    const target = resolveProviderPermissionsTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  app.get('/api/provider-permissions', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return buildProviderPermissionInfo(target);
  });

  app.put<{ Body: unknown }>('/api/provider-permissions', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const draft = parseProviderPermissionsDraft(request.body, target.format);
    if (!draft) {
      // `yolo` отклоняем отдельным сообщением: это не опечатка, а режим, который
      // Gemini принимает ТОЛЬКО флагом CLI.
      if (target.format === 'gemini-json' && isCliOnlyGeminiApprovalMode(request.body)) {
        return reply.code(400).send(MODE_CLI_ONLY);
      }
      return reply.code(400).send(INVALID_DRAFT);
    }

    try {
      return done(saveProviderPermissions(target, draft, ctx.backupDir));
    } catch (error) {
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  });
}
