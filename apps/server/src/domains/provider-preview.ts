import { existsSync, readFileSync } from 'node:fs';
import type {
  AppSettings,
  ProviderPreviewRequest,
  ProviderPreviewResponse,
} from '@claude-control/contracts';
import { createConfigSandbox } from '../lib/config-sandbox.ts';
import { diffLines } from './history.ts';
import {
  resolveProviderMcpTarget,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  parseUniversalDraft,
} from './provider-mcp.ts';
import {
  resolveProviderPermissionsTarget,
  parseProviderPermissionsDraft,
  saveProviderPermissions,
} from './provider-permissions.ts';
import {
  resolveProviderEnvTarget,
  parseProviderEnvDraft,
  saveProviderEnvVars,
} from './provider-env.ts';
import {
  resolveProviderInstructionsTarget,
  parseProviderInstructionsDraft,
  saveProviderInstructionsEntries,
} from './provider-instructions.ts';

/**
 * Предпросмотр записи в чужой конфиг (IDEA-10).
 *
 * Панель правит файлы, которые человек вёл руками, и в чужом формате «сохранить»
 * — шаг вслепую: не видно ни того, что окажется в файле, ни того, не заденет ли
 * запись соседние ключи. Здесь она сначала показывает результат.
 *
 * Результат НАСТОЯЩИЙ, а не предсказанный: выполняется та же самая операция тем
 * же адаптером, только по временной копии файла (`lib/config-sandbox.ts`), после
 * чего текст копии сравнивается с текстом оригинала. Отдельного «генератора
 * предпросмотра» нет намеренно — он неизбежно разошёлся бы с настоящей записью,
 * и предпросмотр начал бы врать.
 *
 * Копии (`backupDir`) при этом не делаются: копия делается при НАСТОЯЩЕЙ записи,
 * а предпросмотр не должен засорять ротацию бэкапов и вытеснять из неё историю.
 */

/** Минимум настроек, нужный резолверам разделов (без импорта AppStore). */
interface PreviewSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Раздел не поддержан активным провайдером — маршрут ответит 400 (fail-closed). */
export class SectionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionUnsupportedError';
  }
}

/** Черновик не прошёл проверку — маршрут ответит 400, как и на записи. */
export class InvalidDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDraftError';
  }
}

/**
 * Порог построчного сравнения. Выше него дифф не строится вовсе: LCS квадратичен
 * по числу строк, а показывать обрезанный кусок как полную картину — хуже, чем
 * честно сказать «файл слишком велик».
 */
const MAX_DIFF_CHARS = 400_000;

export function previewProviderWrite(
  store: PreviewSettingsSource,
  request: ProviderPreviewRequest,
): ProviderPreviewResponse {
  switch (request.section) {
    case 'mcp':
      return previewMcp(store, request);
    case 'permissions':
      return previewPermissions(store, request);
    case 'env':
      return previewEnv(store, request);
    default:
      return previewInstructions(store, request);
  }
}

/**
 * Общая часть всех разделов: скопировать файл, дать операции отработать по копии
 * и сравнить тексты. `apply` получает путь копии и пишет по нему.
 *
 * Экспортируется ради переноса между провайдерами (IDEA-4): там предпросмотр
 * такой же по смыслу, только записей за раз несколько. Второй такой функции быть
 * не должно — она разошлась бы с этой, и один из предпросмотров начал бы врать.
 */
export function runPreview(
  meta: { providerId: string; providerName: string; filePath: string },
  apply: (sandboxPath: string) => void,
): ProviderPreviewResponse {
  const exists = existsSync(meta.filePath);
  const before = exists ? readFileSync(meta.filePath, 'utf8') : '';

  const sandbox = createConfigSandbox(meta.filePath);
  let after: string;
  try {
    apply(sandbox.path);
    after = existsSync(sandbox.path) ? readFileSync(sandbox.path, 'utf8') : '';
  } finally {
    sandbox.dispose();
  }

  const base = {
    providerId: meta.providerId,
    providerName: meta.providerName,
    filePath: meta.filePath,
    exists,
    unchanged: before === after,
  };

  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) {
    return { ...base, lines: [], added: 0, removed: 0, truncated: true };
  }

  const diff = diffLines(before, after);
  return { ...base, lines: diff.lines, added: diff.added, removed: diff.removed, truncated: false };
}

function previewMcp(
  store: PreviewSettingsSource,
  request: ProviderPreviewRequest,
): ProviderPreviewResponse {
  const target = resolveProviderMcpTarget(store);
  if (!target) throw new SectionUnsupportedError('У активного провайдера нет раздела MCP.');

  const meta = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    filePath: target.filePath,
  };

  if (request.action === 'delete') {
    const serverId = typeof request.serverId === 'string' ? request.serverId : '';
    if (!serverId) throw new InvalidDraftError('Не указан сервер для удаления.');
    return runPreview(meta, (path) =>
      deleteProviderMcpServer(
        { ...target, filePath: path, backupName: undefined },
        serverId,
        undefined,
      ),
    );
  }

  const draft = parseUniversalDraft(request.draft);
  if (!draft) throw new InvalidDraftError('Черновик сервера не прошёл проверку.');

  const serverId =
    typeof request.serverId === 'string' && request.serverId ? request.serverId : null;
  return runPreview(meta, (path) =>
    upsertProviderMcpServer(
      { ...target, filePath: path, backupName: undefined },
      serverId,
      draft,
      undefined,
    ),
  );
}

function previewPermissions(
  store: PreviewSettingsSource,
  request: ProviderPreviewRequest,
): ProviderPreviewResponse {
  const target = resolveProviderPermissionsTarget(store);
  if (!target) throw new SectionUnsupportedError('У активного провайдера нет раздела прав.');

  // Форму черновика задаёт ФАЙЛ провайдера, а не клиент, — ровно как на записи:
  // так подложить codex-черновик в gemini-файл нельзя и в предпросмотре.
  const draft = parseProviderPermissionsDraft(request.draft, target.format);
  if (!draft) throw new InvalidDraftError('Черновик прав не прошёл проверку.');

  return runPreview(
    {
      providerId: target.provider.id,
      providerName: target.provider.name,
      filePath: target.filePath,
    },
    (path) =>
      saveProviderPermissions(
        { ...target, filePath: path, backupName: undefined },
        draft,
        undefined,
      ),
  );
}

function previewEnv(
  store: PreviewSettingsSource,
  request: ProviderPreviewRequest,
): ProviderPreviewResponse {
  const target = resolveProviderEnvTarget(store);
  if (!target)
    throw new SectionUnsupportedError('У активного провайдера нет раздела переменных окружения.');

  const vars = parseProviderEnvDraft(request.draft);
  if (!vars) throw new InvalidDraftError('Черновик переменных не прошёл проверку.');

  return runPreview(
    {
      providerId: target.provider.id,
      providerName: target.provider.name,
      filePath: target.filePath,
    },
    (path) =>
      saveProviderEnvVars({ ...target, filePath: path, backupName: undefined }, vars, undefined),
  );
}

function previewInstructions(
  store: PreviewSettingsSource,
  request: ProviderPreviewRequest,
): ProviderPreviewResponse {
  const target = resolveProviderInstructionsTarget(store);
  if (!target)
    throw new SectionUnsupportedError('У активного провайдера нет списка файлов инструкций.');

  const entries = parseProviderInstructionsDraft(request.draft);
  if (!entries) throw new InvalidDraftError('Черновик списка не прошёл проверку.');

  return runPreview(
    {
      providerId: target.provider.id,
      providerName: target.provider.name,
      filePath: target.configPath,
    },
    (path) =>
      saveProviderInstructionsEntries(
        { ...target, configPath: path, backupName: undefined },
        entries,
        undefined,
      ),
  );
}
