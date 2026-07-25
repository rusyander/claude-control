import { existsSync } from 'node:fs';
import type {
  CompareEntry,
  CompareSection,
  CompareSectionResult,
  CompareSide,
  CompareState,
  EnvVar,
  McpServer,
  PermissionRule,
  ProviderCompareResponse,
  ProviderMigrateRequest,
  ProviderMigrateResponse,
  MigrateSkip,
  UniversalMcpServer,
} from '@claude-control/contracts';
import { getProvider, providerSettingsSource } from '../providers/registry.ts';
import { readTextFile } from '../lib/safe-io.ts';
import { runPreview } from './provider-preview.ts';
import {
  resolveProviderMcpTarget,
  readProviderMcpServers,
  upsertProviderMcpServer,
} from './provider-mcp.ts';
import {
  resolveProviderPermissionsTarget,
  readProviderPermissions,
} from './provider-permissions.ts';
import { resolveProviderEnvTarget, readProviderEnvVars } from './provider-env.ts';
import { resolveInstructionsTarget, writeInstructions } from './instructions.ts';

/**
 * Сравнение двух провайдеров и перенос записей между ними (IDEA-5 + IDEA-4).
 *
 * Сравнение отвечает на вопрос, который иначе решается только памятью: что
 * настроено у Claude, чего нет у Codex и наоборот. Каждый раздел приводится к
 * паре «ключ → показываемое значение», разница считается по ключу, а значения
 * сравниваются по СМЫСЛУ (нормализованный JSON), а не по тексту файла: один и
 * тот же сервер в TOML и JSON записан по-разному, и построчный дифф здесь врал
 * бы.
 *
 * Перенос намеренно уже сравнения:
 * - **MCP-серверы** переносятся — для них есть межвендорная модель и настоящие
 *   адаптеры записи с обеих сторон;
 * - **текст глобальных инструкций** переносится — это обычный файл;
 * - **переменные окружения** не переносятся никогда: их значения чаще всего
 *   ключи и токены, а секреты панель в чужие конфигурации не пишет;
 * - **права** не переносятся: у семи моделей согласований нет общего словаря, и
 *   перевод одного режима в другой был бы догадкой.
 *
 * Claude участвует обеими сторонами, но живёт на собственных файлах и читается
 * своими функциями. Их сюда ВНЕДРЯЮТ (`ClaudeSide`), а не импортируют: иначе
 * домен потянул бы за собой AppStore ради идентификаторов групп, которые
 * сравнению не нужны вовсе.
 */

/** Доступ к данным Claude — его читатели живут на своих файлах и знают про группы. */
export interface ClaudeSide {
  /** `~/.claude.json` — там же живут MCP-серверы. */
  mcpConfigPath: string;
  /** Путь CLAUDE.md выбирается обнаружением каталога, а не строится заново. */
  claudeMdPath: string;
  readMcp: () => McpServer[];
  readEnv: () => EnvVar[];
  readPermissions: () => PermissionRule[];
  /** Запись MCP-сервера в файл Claude; путь передаётся отдельно ради предпросмотра. */
  writeMcp: (filePath: string, server: UniversalMcpServer, backupDir: string | undefined) => void;
}

export interface CompareDeps {
  claudeDirOverride?: string;
  claude: ClaudeSide;
  /** Каталог резервных копий; в предпросмотре не используется. */
  backupDir?: string;
}

/** Неизвестный провайдер или сравнение провайдера с самим собой — маршрут ответит 400. */
export class CompareRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareRequestError';
  }
}

/** Одна прочитанная сторона раздела: что нашли и почему могли не найти. */
interface SideRead {
  supported: boolean;
  filePath?: string;
  note?: string;
  rows: Row[];
}

/** Запись раздела, приведённая к общему виду. */
interface Row {
  key: string;
  /** Что показать человеку. */
  display: string;
  /** По чему считать равенство. Не задано — сравниваем по `display`. */
  compare?: string;
  /** Значение не сравнивается по содержимому (секрет) — сверяем только наличие. */
  opaque?: boolean;
  /** Почему запись нельзя перенести. */
  blocked?: string;
  /** Данные для переноса. */
  payload?: UniversalMcpServer;
}

/** Ключ, под которым в разделе инструкций живёт единственная запись — сам файл. */
const INSTRUCTIONS_KEY = 'Файл инструкций';

/** Имена, по которым переменная считается секретом. Тот же признак, что в разделе env. */
const SECRET_HINT = /(TOKEN|SECRET|KEY|PASSWORD|PAT|CREDENTIAL)/i;

export function compareProviders(
  leftId: string,
  rightId: string,
  deps: CompareDeps,
): ProviderCompareResponse {
  if (leftId === rightId) {
    throw new CompareRequestError('Сравнивать провайдера с самим собой нечего.');
  }

  const left = getProvider(leftId);
  const right = getProvider(rightId);

  const sections: CompareSectionResult[] = [
    buildSection('mcp', leftId, rightId, deps, mcpSide, { comparable: true, migratable: true }),
    buildSection('env', leftId, rightId, deps, envSide, {
      comparable: true,
      migratable: false,
      note: 'Переменные не переносятся: их значения — обычно ключи и токены, а секреты панель в чужие конфигурации не пишет.',
    }),
    buildSection('permissions', leftId, rightId, deps, permissionsSide, {
      comparable: false,
      migratable: false,
      note: 'У каждого CLI своя модель согласований. Совпадение имён ключей не означает совпадения смысла, поэтому права показаны рядом, но не переносятся.',
    }),
    buildSection('instructions', leftId, rightId, deps, instructionsSide, {
      comparable: true,
      migratable: true,
    }),
  ];

  return {
    left: { providerId: left.id, providerName: left.name },
    right: { providerId: right.id, providerName: right.name },
    sections,
  };
}

function buildSection(
  section: CompareSection,
  leftId: string,
  rightId: string,
  deps: CompareDeps,
  read: (providerId: string, deps: CompareDeps) => SideRead,
  meta: { comparable: boolean; migratable: boolean; note?: string },
): CompareSectionResult {
  const left = read(leftId, deps);
  const right = read(rightId, deps);

  return {
    section,
    left: sideOf(leftId, left),
    right: sideOf(rightId, right),
    entries: compareRows(left, right, meta.migratable),
    comparable: meta.comparable,
    // Переносить можно, только если раздел прочитан С ОБЕИХ сторон: иначе
    // «перенести» означало бы «угадать, куда».
    migratable: meta.migratable && left.supported && right.supported,
    note: meta.note,
  };
}

function sideOf(providerId: string, read: SideRead): CompareSide {
  const provider = getProvider(providerId);
  return {
    providerId: provider.id,
    providerName: provider.name,
    supported: read.supported,
    filePath: read.filePath,
    note: read.note,
  };
}

/**
 * Свести две стороны в список записей. Пустая сторона (раздел не поддержан) не
 * порождает «только слева» на весь список другой стороны — иначе экран заполнялся
 * бы разницей, которой не существует.
 */
function compareRows(left: SideRead, right: SideRead, migratable: boolean): CompareEntry[] {
  if (!left.supported && !right.supported) return [];

  const keys = new Set<string>();
  for (const row of left.rows) keys.add(row.key);
  for (const row of right.rows) keys.add(row.key);

  const leftBy = new Map(left.rows.map((row) => [row.key, row]));
  const rightBy = new Map(right.rows.map((row) => [row.key, row]));

  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key): CompareEntry => {
      const l = leftBy.get(key);
      const r = rightBy.get(key);
      const opaque = Boolean(l?.opaque || r?.opaque);

      let state: CompareState;
      if (l && r) {
        // Секреты сверяем только по наличию: сравнивать их значения означало бы
        // читать и держать их рядом, а показывать разницу — намекать на них.
        state = opaque || sameValue(l, r) ? 'same' : 'differs';
      } else if (l) {
        state = 'left-only';
      } else {
        state = 'right-only';
      }

      const blocked = l?.blocked ?? r?.blocked;
      return {
        key,
        left: l?.display,
        right: r?.display,
        state,
        opaque,
        blocked: migratable ? blocked : undefined,
      };
    });
}

function sameValue(a: Row, b: Row): boolean {
  return (a.compare ?? a.display) === (b.compare ?? b.display);
}

/* ---------------------------------------------------------------- разделы */

function mcpSide(providerId: string, deps: CompareDeps): SideRead {
  if (providerId === 'claude') {
    const servers = deps.claude.readMcp();
    return {
      supported: true,
      filePath: deps.claude.mcpConfigPath,
      rows: servers.map((server) => mcpRow(claudeToUniversal(server), server)),
    };
  }

  const target = resolveProviderMcpTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return unsupported('У этого CLI панель не ведёт MCP-серверы.');

  try {
    return {
      supported: true,
      filePath: target.filePath,
      rows: readProviderMcpServers(target).map((server) => mcpRow(server)),
    };
  } catch {
    return {
      supported: false,
      filePath: target.filePath,
      note: 'Формат файла не распознан — читать его панель не станет.',
      rows: [],
    };
  }
}

/**
 * Богатая модель Claude → переносимый субсет. Транспорт `sse` в него не входит:
 * у чужих CLI его нет, и подменять его на http значило бы записать сервер, к
 * которому CLI не подключится.
 */
function claudeToUniversal(server: McpServer): UniversalMcpServer {
  return {
    name: server.name,
    transport: server.transport === 'stdio' ? 'stdio' : 'http',
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
  };
}

function mcpRow(server: UniversalMcpServer, claude?: McpServer): Row {
  const blocked =
    claude && claude.transport === 'sse'
      ? 'Транспорт sse: у других CLI его нет, переносить некуда.'
      : claude && !claude.isEnabled
        ? 'Сервер выключен — переносим только включённые.'
        : undefined;

  return {
    key: server.name,
    display:
      server.transport === 'stdio'
        ? `stdio · ${[server.command, ...server.args].filter(Boolean).join(' ')}`
        : `http · ${server.url ?? ''}`,
    compare: stableJson({
      transport: server.transport,
      command: server.command ?? '',
      args: server.args,
      url: server.url ?? '',
      env: server.env,
      headers: server.headers,
    }),
    blocked,
    payload: server,
  };
}

function envSide(providerId: string, deps: CompareDeps): SideRead {
  if (providerId === 'claude') {
    return {
      supported: true,
      rows: deps.claude.readEnv().map((item) => ({
        key: item.key,
        // Значение приходит уже замаскированным, если это секрет, — маскировать
        // повторно нечего, а показывать больше, чем показывает раздел env, нельзя.
        display: item.value,
        opaque: item.isSecret,
      })),
    };
  }

  const target = resolveProviderEnvTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return unsupported('У этого CLI панель не ведёт переменные окружения.');

  try {
    return {
      supported: true,
      filePath: target.filePath,
      rows: readProviderEnvVars(target).map((item) => {
        const secret = SECRET_HINT.test(item.key);
        return {
          key: item.key,
          display: secret ? maskValue(item.value) : item.value,
          opaque: secret,
        };
      }),
    };
  } catch {
    return {
      supported: false,
      filePath: target.filePath,
      note: 'Формат файла не распознан — читать его панель не станет.',
      rows: [],
    };
  }
}

function permissionsSide(providerId: string, deps: CompareDeps): SideRead {
  if (providerId === 'claude') {
    return {
      supported: true,
      rows: deps.claude.readPermissions().map((rule) => ({
        key: rule.pattern,
        display: rule.decision,
      })),
    };
  }

  const target = resolveProviderPermissionsTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return unsupported('У этого CLI панель не ведёт права.');

  try {
    const values = readProviderPermissions(target) as unknown as Record<string, unknown>;
    return {
      supported: true,
      filePath: target.filePath,
      rows: flattenValues(values),
    };
  } catch {
    return {
      supported: false,
      filePath: target.filePath,
      note: 'Формат файла не распознан — читать его панель не станет.',
      rows: [],
    };
  }
}

/**
 * Значения прав — объект своей формы у каждого CLI. Раскладываем его в плоские
 * пары «ключ → значение»: списки становятся перечислением, скаляры — собой.
 * Служебный `usingDefaults` (файла ещё нет) в сравнение не идёт: это факт о
 * файле, а не о правах.
 */
function flattenValues(values: Record<string, unknown>): Row[] {
  return Object.entries(values)
    .filter(([key]) => key !== 'usingDefaults')
    .map(([key, value]): Row => {
      if (Array.isArray(value)) {
        return {
          key,
          display: value.length ? value.map(String).join(', ') : '—',
          compare: stableJson(value),
        };
      }
      if (value && typeof value === 'object') {
        return { key, display: summarizeObject(value), compare: stableJson(value) };
      }
      return { key, display: value === undefined ? '—' : String(value) };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeObject(value: object): string {
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '—';
  return entries.map(([key, item]) => `${key}: ${String(item)}`).join(', ');
}

function instructionsSide(providerId: string, deps: CompareDeps): SideRead {
  const target = resolveInstructionsTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
    deps.claude.claudeMdPath,
  );
  if (!target) {
    return unsupported('У этого CLI глобальные инструкции устроены иначе — не одним файлом.');
  }

  const exists = existsSync(target.filePath);
  const content = exists ? readTextFile(target.filePath) : '';

  return {
    supported: true,
    filePath: target.filePath,
    rows: [
      {
        key: INSTRUCTIONS_KEY,
        display: exists
          ? `${target.fileName} · ${sizeOf(content)}`
          : `${target.fileName} · нет файла`,
        // Сравниваем СОДЕРЖИМОЕ: имена файлов у CLI разные всегда, и разница имён
        // не новость. Интересно, одинаков ли текст.
        compare: content,
        blocked: exists ? undefined : 'Файла нет — переносить нечего.',
      },
    ],
  };
}

function sizeOf(content: string): string {
  const bytes = Buffer.byteLength(content, 'utf8');
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

function unsupported(note: string): SideRead {
  return { supported: false, note, rows: [] };
}

/** Маска секрета: как в разделе env — видно начало и хвост, середины нет. */
function maskValue(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortDeep(item)]),
  );
}

/* --------------------------------------------------------------- перенос */

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
  const { from, to, section } = request;
  const mode = request.mode ?? 'preview';

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
    apply: (server, backupDir) =>
      void upsertProviderMcpServer(target, null, draftOf(server), backupDir),
    applyTo: (path, server) =>
      void upsertProviderMcpServer(
        { ...target, filePath: path, backupName: undefined },
        null,
        draftOf(server),
        undefined,
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
