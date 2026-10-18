import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gitSyncOutcome } from '../project-git/exec/exec.ts';
import { buildLayer, MIN_SAVED_CHARS, PATH_RULES_SCRIPT, runArgsOf } from './build.ts';
import { readTeamLayer, teamSourcePaths, type TeamPlace } from './team-layer.ts';
import type {
  LayerConfig,
  LayerRunExtras,
  LocalLayerMode,
  LocalLayerStatus,
} from './local-layer.types.ts';

/**
 * Локальный слой проекта — фасад для реестра прогонов и маршрутов.
 *
 * Слой существует, только если в проекте есть `.agent/local-layer/layer.json`:
 * без него панель не создаёт ни одного файла и чат запускается как прежде.
 * С ним на каждом старте снимается отпечаток командного слоя (стат файлов, без
 * чтения содержимого); изменился — слой пересобирается тут же, до запуска, так
 * что агент никогда не получает устаревшую копию командных правил.
 *
 * Режим `auto` подключает слой, только когда он что-то даёт: действующую замену
 * хуков или сжатие инструкций не меньше `MIN_SAVED_CHARS`. Иначе — командный
 * слой как есть: слой без выгоды ничего не стоит включать.
 */

export const LAYER_DIR = join('.agent', 'local-layer');

const memo = new Map<string, { signature: string; status: LocalLayerStatus }>();

interface Manifest {
  signature: string;
  closure: string[];
  overridesActive: number;
  savedChars: number;
  status: Omit<LocalLayerStatus, 'mode' | 'configured' | 'used' | 'reason' | 'root'>;
}

export function placeOf(env: NodeJS.ProcessEnv = process.env): TeamPlace {
  const home = homedir();
  return {
    home,
    configDir: env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude'),
    caseless: process.platform === 'win32' || process.platform === 'darwin',
  };
}

const layerDirOf = (root: string): string => join(root, LAYER_DIR);

function readJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function readLayerConfig(root: string): LayerConfig | undefined {
  const raw = readJson<Partial<LayerConfig>>(join(layerDirOf(root), 'layer.json'));
  if (!raw) return undefined;
  const mode: LocalLayerMode = raw.mode === 'on' || raw.mode === 'off' ? raw.mode : 'auto';
  const overrides = Array.isArray(raw.overrides)
    ? raw.overrides.filter(
        (item) =>
          item &&
          typeof item.ref === 'string' &&
          Array.isArray(item.entries) &&
          item.entries.every((entry) => typeof entry === 'string'),
      )
    : [];
  return { mode, overrides };
}

/** Каталог `.git` (в копии — её собственный) поиском вверх; нет — не репозиторий. */
function gitDirOf(root: string): string | undefined {
  let dir = resolve(root);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      return pointer ? resolve(dir, pointer) : undefined;
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Коммит HEAD чтением файлов `.git`, без запуска git: отпечаток снимается на
 * каждом старте чата. Нужен заменам — их годность считается от HEAD.
 */
export function headOf(root: string): string {
  try {
    return headIn(root);
  } catch {
    return '';
  }
}

function headIn(root: string): string {
  const gitDir = gitDirOf(root);
  if (!gitDir) return '';
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  const commonFile = join(gitDir, 'commondir');
  const common = existsSync(commonFile)
    ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
    : gitDir;
  for (const dir of [gitDir, common]) {
    const loose = join(dir, ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
  }
  const packed = join(common, 'packed-refs');
  if (existsSync(packed)) {
    const line = readFileSync(packed, 'utf8')
      .split(/\r?\n/)
      .find((item) => item.endsWith(` ${ref}`));
    if (line) return line.split(' ')[0] as string;
  }
  return head;
}

function stamp(file: string): string {
  try {
    const info = statSync(file);
    return `${file}:${info.mtimeMs}:${info.size}`;
  } catch {
    return `${file}:-`;
  }
}

/**
 * Код самого сборщика тоже часть отпечатка: обновлённая панель пересобирает
 * слой, собранный прежней версией, а не ждёт правки командных файлов.
 */
const BUILDER_FILES = [
  ...readdirSync(dirname(fileURLToPath(import.meta.url)))
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
    .map((name) => join(dirname(fileURLToPath(import.meta.url)), name)),
  PATH_RULES_SCRIPT,
];

function signatureOf(root: string, place: TeamPlace, closure: readonly string[]): string {
  const layerDir = layerDirOf(root);
  const compressedDir = join(layerDir, 'compressed');
  const compressed = existsSync(compressedDir)
    ? readdirSync(compressedDir).map((name) => join(compressedDir, name))
    : [];
  const parts = [
    root,
    headOf(root),
    ...BUILDER_FILES.map(stamp),
    stamp(join(layerDir, 'layer.json')),
    ...compressed.map(stamp),
    ...teamSourcePaths(root, place).map(stamp),
    ...closure.map((rel) => stamp(isAbsolute(rel) ? rel : join(root, rel))),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * `.agent/local-layer/` не должен попасть в git проекта. Чаще `.agent/` уже
 * исключён; если нет — строка уходит в `info/exclude` репозитория, локальный
 * файл, который git не отправляет никуда.
 */
function ensureExcluded(root: string): void {
  const probe = gitSyncOutcome(root, [
    'check-ignore',
    '-q',
    `${LAYER_DIR.replaceAll('\\', '/')}/layer.json`,
  ]);
  if (probe.ok) return;
  const where = gitSyncOutcome(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!where.ok) return;
  const file = resolve(root, where.stdout.trim());
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n/${LAYER_DIR.replaceAll('\\', '/')}/\n`, 'utf8');
}

export function writeLayerMode(root: string, mode: LocalLayerMode): LayerConfig {
  const current = readLayerConfig(root) ?? { mode: 'auto', overrides: [] };
  const next = { ...current, mode };
  mkdirSync(layerDirOf(root), { recursive: true });
  ensureExcluded(root);
  writeFileSync(join(layerDirOf(root), 'layer.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  memo.delete(root);
  return next;
}

function emptyStatus(root: string, mode: LocalLayerMode, configured: boolean): LocalLayerStatus {
  return {
    root,
    mode,
    configured,
    used: false,
    reason: configured ? 'off' : 'no-config',
    instructions: {
      files: 0,
      teamChars: 0,
      layerChars: 0,
      sections: 0,
      compressed: 0,
      pending: [],
    },
    pathRules: 0,
    skills: [],
    agents: 0,
    commands: 0,
    mcpServers: [],
    hooks: 0,
    overrides: [],
    orphans: [],
    excluded: 0,
  };
}

/** Состояние слоя, при нужде — пересборка. Чат и страница проекта читают одно и то же. */
export function localLayerStatus(root: string, place: TeamPlace = placeOf()): LocalLayerStatus {
  const config = readLayerConfig(root);
  if (!config) return emptyStatus(root, 'auto', false);
  if (config.mode === 'off') return emptyStatus(root, 'off', true);

  const layerDir = layerDirOf(root);
  const manifestFile = join(layerDir, 'build', 'manifest.json');
  const previous = readJson<Manifest>(manifestFile);
  const signature = signatureOf(root, place, previous?.closure ?? []);
  const cached = memo.get(root);
  if (cached && cached.signature === signature) return cached.status;

  let manifest = previous?.signature === signature ? previous : undefined;
  let error: string | undefined;
  if (!manifest) {
    try {
      ensureExcluded(root);
      const team = readTeamLayer(root, place);
      const local = readJson<Record<string, unknown>>(join(root, '.claude', 'settings.local.json'));
      const built = buildLayer({ root, layerDir, team, config, local, caseless: place.caseless });
      // Отпечаток — после сборки: замыкание замен известно только теперь.
      manifest = {
        signature: signatureOf(root, place, built.closure),
        closure: built.closure,
        overridesActive: built.overridesActive,
        savedChars: built.savedChars,
        status: built.status,
      };
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  if (!manifest) {
    const broken = { ...emptyStatus(root, config.mode, true), reason: 'broken' as const, error };
    return broken;
  }
  const gain = manifest.overridesActive > 0 || manifest.savedChars >= MIN_SAVED_CHARS;
  const used = config.mode === 'on' || gain;
  const status: LocalLayerStatus = {
    root,
    mode: config.mode,
    configured: true,
    used,
    reason: config.mode === 'on' ? 'on' : gain ? 'gain' : 'no-gain',
    ...manifest.status,
  };
  memo.set(root, { signature: manifest.signature, status });
  return status;
}

/**
 * `--setting-sources` прогона без источника `project`: командный слой приходит
 * из локальной копии. Флага не было — `user,local`. После снятия не осталось
 * ни одного источника — слой этому прогону не подходит (`undefined`).
 */
export function withoutProjectSource(args: readonly string[]): string[] | undefined {
  const out = [...args];
  let found = false;
  for (
    let at = out.indexOf('--setting-sources');
    at >= 0;
    at = out.indexOf('--setting-sources', at + 1)
  ) {
    found = true;
    const sources = (out[at + 1] ?? '').split(',').map((source) => source.trim());
    // Маршрут уже снял командный слой (локальная модель, `local`) — подменять нечего,
    // а слой вернул бы то, что маршрут убрал намеренно.
    if (!sources.includes('project')) return undefined;
    const left = sources.filter((source) => source && source !== 'project');
    if (left.length === 0) return undefined;
    out[at + 1] = left.join(',');
  }
  return found ? out : [...out, '--setting-sources', 'user,local'];
}

/**
 * Флаги слоя без `--mcp-config`: маршрут со `--strict-mcp-config` выбирает
 * серверы сам, и `.mcp.json` проекта он не взял бы и без слоя.
 */
export function withoutMcpConfig(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === '--mcp-config') at += 1;
    else out.push(args[at] as string);
  }
  return out;
}

/**
 * Настройки флага: слой снизу, профиль группы сверху. Хуки по событию и списки
 * прав складываются — так CLI поступил бы с двумя источниками и сам.
 */
export function mergeFlagSettings(
  layer: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...layer, ...over };
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const lists = (a: unknown, b: unknown): Record<string, unknown[]> => {
    const out: Record<string, unknown[]> = {};
    for (const [key, value] of [...Object.entries(object(a)), ...Object.entries(object(b))]) {
      if (Array.isArray(value)) out[key] = [...(out[key] ?? []), ...value];
      else out[key] = value as unknown[];
    }
    return out;
  };
  if (layer.hooks || over.hooks) merged.hooks = lists(layer.hooks, over.hooks);
  if (layer.permissions || over.permissions)
    merged.permissions = lists(layer.permissions, over.permissions);
  return merged;
}

/** Что прогон получает от слоя; `undefined` — слой не подключается. */
export function localLayerRun(
  root: string,
  place: TeamPlace = placeOf(),
): LayerRunExtras | undefined {
  const status = localLayerStatus(root, place);
  if (!status.used) return undefined;
  const extras = runArgsOf(layerDirOf(root));
  return { ...extras, status };
}
