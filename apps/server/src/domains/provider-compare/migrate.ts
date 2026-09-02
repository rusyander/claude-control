import { existsSync } from 'node:fs';
import type {
  MigrateSkip,
  ProviderMigrateRequest,
  ProviderMigrateResponse,
  UniversalMcpServer,
} from '@claude-control/contracts';
import { getProvider, providerSettingsSource } from '../../providers/registry.ts';
import { readTextFile } from '../../lib/safe-io.ts';
import { runPreview } from '../provider-preview.ts';
import { resolveProviderMcpTarget, upsertProviderMcpServer } from '../provider-mcp.ts';
import { resolveInstructionsTarget, writeInstructions } from '../instructions.ts';
import { mcpSide } from './sections.ts';
import { CompareRequestError, type CompareDeps } from './types.ts';

/**
 * Перенос записей из одного провайдера в другой.
 *
 * `preview` считает дифф целевого файла ровно тем же приёмом, что и предпросмотр
 * одиночной записи: временная копия, настоящие адаптеры, сравнение текстов.
 * `apply` выполняет те же операции по настоящему файлу — с резервной копией.
 *
 * Пропуски не молчат: всё, что не перенеслось (нет такой записи у источника,
 * запись заблокирована, раздел не переносится), возвращается списком с причиной.
 */
export function migrateProvider(
  request: ProviderMigrateRequest,
  deps: CompareDeps,
): ProviderMigrateResponse {
  const { from, to, section, mode } = assertMigrateRequest(request);

  if (from === to) throw new CompareRequestError('Источник и приёмник совпадают.');
  if (section !== 'mcp' && section !== 'instructions') {
    throw new CompareRequestError(
      section === 'env'
        ? 'Переменные окружения панель не переносит: в них хранятся ключи.'
        : 'Права не переносятся: у CLI разные модели согласований.',
    );
  }

  return section === 'mcp'
    ? migrateMcp(from, to, request.keys ?? [], mode, deps)
    : migrateInstructions(from, to, mode, deps);
}

const SECTIONS: ReadonlySet<string> = new Set(['mcp', 'env', 'permissions', 'instructions']);
const MODES: ReadonlySet<string> = new Set(['preview', 'apply']);

/**
 * Тело переноса приходит по HTTP и типу не верит. Раньше оно не проверялось:
 * `keys: 'telegram-inbox'` (строка) обходился ПОСИМВОЛЬНО и давал 14 «пропусков»,
 * `mode: 'bogus'` молча считался предпросмотром и возвращался как режим, а
 * пропущенный раздел падал в ветку «права не переносятся». Fail-closed: всё,
 * что не по контракту, — `CompareRequestError` → 400 с внятной причиной.
 */
export function assertMigrateRequest(
  body: unknown,
): ProviderMigrateRequest & { mode: 'preview' | 'apply' } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const { from, to, section, keys, mode } = raw;

  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
    throw new CompareRequestError('Поля from и to обязаны быть непустыми строками.');
  }
  if (typeof section !== 'string' || !SECTIONS.has(section)) {
    throw new CompareRequestError(
      'Поле section обязано быть одним из: mcp, env, permissions, instructions.',
    );
  }
  if (mode !== undefined && (typeof mode !== 'string' || !MODES.has(mode))) {
    throw new CompareRequestError('Поле mode обязано быть preview или apply.');
  }
  if (
    keys !== undefined &&
    (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key))
  ) {
    throw new CompareRequestError('Поле keys обязано быть списком непустых строк.');
  }

  return {
    from,
    to,
    section: section as ProviderMigrateRequest['section'],
    keys: keys as string[] | undefined,
    mode: (mode as 'preview' | 'apply' | undefined) ?? 'preview',
  };
}

function migrateMcp(
  from: string,
  to: string,
  keys: string[],
  mode: 'preview' | 'apply',
  deps: CompareDeps,
): ProviderMigrateResponse {
  const source = mcpSide(from, deps);
  if (!source.supported) throw new CompareRequestError('У источника нет раздела MCP-серверов.');

  const skipped: MigrateSkip[] = [];
  const chosen: UniversalMcpServer[] = [];
  const byKey = new Map(source.rows.map((row) => [row.key, row]));

  for (const key of keys) {
    const row = byKey.get(key);
    if (!row?.payload) {
      skipped.push({ key, reason: 'У источника такого сервера нет.' });
      continue;
    }
    if (row.blocked) {
      skipped.push({ key, reason: row.blocked });
      continue;
    }
    chosen.push(row.payload);
  }

  const applied = chosen.map((server) => server.name);
  const write = mcpWriter(to, deps);

  if (mode === 'apply') {
    for (const server of chosen) write.apply(server, deps.backupDir);
    return { mode, ...write.meta, applied, skipped };
  }

  const diff = runPreview(
    {
      providerId: write.meta.providerId,
      providerName: write.meta.providerName,
      filePath: write.meta.filePath,
    },
    (sandboxPath) => {
      for (const server of chosen) write.applyTo(sandboxPath, server);
    },
  );

  return { mode, ...write.meta, applied, skipped, diff };
}

/** Куда и чем писать MCP-серверы у приёмника: у Claude свой файл, у прочих — адаптер. */
function mcpWriter(
  to: string,
  deps: CompareDeps,
): {
  meta: { providerId: string; providerName: string; filePath: string };
  apply: (server: UniversalMcpServer, backupDir: string | undefined) => void;
  applyTo: (filePath: string, server: UniversalMcpServer) => void;
} {
  if (to === 'claude') {
    const provider = getProvider('claude');
    const filePath = deps.claude.mcpConfigPath;
    return {
      meta: { providerId: provider.id, providerName: provider.name, filePath },
      apply: (server, backupDir) => deps.claude.writeMcp(filePath, server, backupDir),
      applyTo: (path, server) => deps.claude.writeMcp(path, server, undefined),
    };
  }

  const target = resolveProviderMcpTarget(providerSettingsSource(to, deps.claudeDirOverride));
  if (!target) throw new CompareRequestError('У приёмника нет раздела MCP-серверов.');

  const draftOf = (server: UniversalMcpServer) => ({
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
  });

  return {
    meta: {
      providerId: target.provider.id,
      providerName: target.provider.name,
      filePath: target.filePath,
    },
    // allowOverwrite: перенос — это осознанное «сделать как у источника»:
    // одноимённый сервер приёмника заменяется намеренно, и пользователь видит
    // замену в предпросмотре ДО применения. Конфликтом отвечают формы (409).
    apply: (server, backupDir) =>
      void upsertProviderMcpServer(target, null, draftOf(server), backupDir, {
        allowOverwrite: true,
      }),
    applyTo: (path, server) =>
      void upsertProviderMcpServer(
        { ...target, filePath: path, backupName: undefined },
        null,
        draftOf(server),
        undefined,
        { allowOverwrite: true },
      ),
  };
}

function migrateInstructions(
  from: string,
  to: string,
  mode: 'preview' | 'apply',
  deps: CompareDeps,
): ProviderMigrateResponse {
  const sourceTarget = resolveInstructionsTarget(
    providerSettingsSource(from, deps.claudeDirOverride),
    deps.claude.claudeMdPath,
  );
  const targetTarget = resolveInstructionsTarget(
    providerSettingsSource(to, deps.claudeDirOverride),
    deps.claude.claudeMdPath,
  );

  if (!sourceTarget) throw new CompareRequestError('У источника нет файла глобальных инструкций.');
  if (!targetTarget) throw new CompareRequestError('У приёмника нет файла глобальных инструкций.');
  if (!existsSync(sourceTarget.filePath)) {
    throw new CompareRequestError('Файл инструкций источника не существует — переносить нечего.');
  }

  const content = readTextFile(sourceTarget.filePath);
  const meta = {
    providerId: targetTarget.provider.id,
    providerName: targetTarget.provider.name,
    filePath: targetTarget.filePath,
  };
  const applied = [targetTarget.fileName];

  if (mode === 'apply') {
    writeInstructions(targetTarget, content, deps.backupDir);
    return { mode, ...meta, applied, skipped: [] };
  }

  const diff = runPreview(meta, (sandboxPath) =>
    writeInstructions({ ...targetTarget, filePath: sandboxPath }, content, undefined),
  );

  return { mode, ...meta, applied, skipped: [], diff };
}
