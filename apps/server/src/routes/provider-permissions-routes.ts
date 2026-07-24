import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  GeminiApprovalMode,
  ProviderPermissionInfo,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderPermissionsTarget,
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  isCliOnlyGeminiApprovalMode,
  UnrecognizedFormatError,
  GEMINI_APPROVAL_MODES,
  type ProviderPermissionsTarget,
} from '../domains/provider-permissions.ts';

/**
 * Универсальный раздел прав/аппрувов для провайдеров Codex (TOML) и Gemini
 * (settings.json). Claude сюда НЕ ходит: его права на собственных богатых роутах
 * (settings.json allow/deny/ask) — их не трогаем. Клиент выбирает набор роутов по
 * активному провайдеру.
 *
 * Fail-closed: провайдер без `permissions=ready`/`permissionsConfig` → 400
 * `section_unsupported` (Claude/OpenCode/… сюда попадают под этот отказ).
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

  // Допустимые значения (отдаём в GET для селектов). Литеральные типы — из contracts.
  const APPROVAL_POLICIES: CodexApprovalPolicy[] = ['untrusted', 'on-request', 'never'];
  const SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

  const requireTarget = (reply: FastifyReply): ProviderPermissionsTarget | undefined => {
    const target = resolveProviderPermissionsTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  /** Сводка раздела для клиента: общие метаданные + модель по формату файла. */
  const buildInfo = (target: ProviderPermissionsTarget): ProviderPermissionInfo => {
    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      filePath: target.filePath,
      cliDetected: target.cliDetected,
    };

    try {
      const values = readProviderPermissions(target);
      if (values.kind === 'gemini') {
        return {
          ...base,
          kind: 'gemini',
          format: 'gemini-json',
          approvalMode: values.approvalMode,
          approvalModes: [...GEMINI_APPROVAL_MODES] as GeminiApprovalMode[],
          coreTools: values.coreTools,
          excludeTools: values.excludeTools,
          usingDefaults: values.usingDefaults,
          readOnly: false,
        };
      }
      return {
        ...base,
        kind: 'codex',
        format: 'toml',
        approvalPolicy: values.approvalPolicy,
        sandboxMode: values.sandboxMode,
        approvalPolicies: APPROVAL_POLICIES,
        sandboxModes: SANDBOX_MODES,
        usingDefaults: values.usingDefaults,
        readOnly: false,
      };
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение с дефолтами и пометкой.
      if (!(error instanceof UnrecognizedFormatError)) throw error;
      if (target.format === 'gemini-json') {
        return {
          ...base,
          kind: 'gemini',
          format: 'gemini-json',
          approvalMode: 'default',
          approvalModes: [...GEMINI_APPROVAL_MODES] as GeminiApprovalMode[],
          coreTools: [],
          excludeTools: [],
          usingDefaults: true,
          readOnly: true,
          error: error.message,
        };
      }
      return {
        ...base,
        kind: 'codex',
        format: 'toml',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalPolicies: APPROVAL_POLICIES,
        sandboxModes: SANDBOX_MODES,
        usingDefaults: true,
        readOnly: true,
        error: error.message,
      };
    }
  };

  app.get('/api/provider-permissions', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return buildInfo(target);
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
