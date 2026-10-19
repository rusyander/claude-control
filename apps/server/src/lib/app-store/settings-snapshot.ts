import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '@agentdeck/contracts';
import type { AppState } from './app-store.types.ts';

/**
 * Снимок НАСТРОЕК панели для git (решение владельца 19.10): `state.json` — это
 * и настройки, и рабочее состояние машины (ссылки чатов — 5 МБ, планы, кэши), и
 * целиком в git ему нельзя — две машины спорили бы о каждой строке. Сюда идёт
 * только то, что человек выбрал сам: группы, отметки, настройки, правила групп
 * разделения, проекты. Файл лежит рядом со `state.json`; если каталог
 * конфигурации — git-репозиторий (у владельца — приватный `~/.claude`), его
 * белый список берёт этот файл, и на другой машине панель подхватывает его сама.
 *
 * Как отличить «пришёл с другой машины» от «написан мной»: хеш последнего
 * записанного или применённого текста хранится в `settings-snapshot.seen`
 * (в git не идёт). Не совпал — файл принёс git, и при старте его поля
 * применяются поверх здешних; здешнее (`local`) остаётся здешним.
 */

export const SNAPSHOT_FILE = 'settings-snapshot.json';
const SEEN_FILE = 'settings-snapshot.seen';
const VERSION = 1;

/**
 * Каждое поле состояния названо: переносится оно или принадлежит машине. Новое
 * поле без отметки не соберётся — молча не уедет и молча не останется.
 */
const STATE_KEYS = {
  groups: 'portable',
  // Едет с группами: иначе на новой машине удалённая встроенная вернулась бы сама.
  builtinGroups: 'portable',
  automations: 'portable',
  disabled: 'portable',
  disabledByGroup: 'portable',
  disabledHooks: 'portable',
  disabledRules: 'portable',
  envByGroup: 'portable',
  projects: 'portable',
  runnerCommands: 'portable',
  runnerPrefs: 'portable',
  settings: 'portable',
  projectCodeLayout: 'portable',
  projectCascade: 'portable',
  outsideRelay: 'portable',
  integrationLinks: 'portable',
  worktreeMirror: 'portable',
  splitSettings: 'portable',
  splitDefaults: 'portable',
  testsAutoAccept: 'portable',
  permissionPlaces: 'local',
  providerChecks: 'local',
  mcpHealth: 'local',
  projectCodeViews: 'local',
  chatLinks: 'local',
  treePause: 'local',
  chatPins: 'local',
  splitPlans: 'local',
  splitPlanMoves: 'local',
  pushDevices: 'local',
  secretBackupVerifier: 'local',
  integrationHealth: 'local',
  platformHealth: 'local',
  platformApplied: 'local',
  portabilityFidelity: 'local',
  portabilityTransfers: 'local',
  portabilitySubscriptions: 'local',
  platformSpend: 'local',
  platformSmoke: 'local',
  platformActivationNotice: 'local',
  platformGatewayPort: 'local',
  platformThinkTail: 'local',
  chatGroupSettings: 'local',
  chatKeyAliases: 'local',
  chatEscalations: 'local',
} as const satisfies Record<keyof AppState, 'portable' | 'local'>;

export const PORTABLE_KEYS = (Object.keys(STATE_KEYS) as (keyof AppState)[]).filter(
  (key) => STATE_KEYS[key] === 'portable',
);

/**
 * Настройки этой машины внутри `settings`: свой каталог конфигурации и свой адрес
 * удалённого доступа. Чужой адрес Tailscale на другой машине вёл бы в эту.
 */
const LOCAL_SETTINGS = [
  'claudeDirOverride',
  'remoteAccess',
] as const satisfies readonly (keyof AppSettings)[];

/** Ключ, значение которого — секрет: в снимок не пишется, даже если когда-то попадёт в состояние. */
const SECRET_KEY = /token|secret|password|passphrase|api[-_]?key|credential|bearer/i;

/** Метки домашнего каталога: как есть и в нормализованном виде (нижний регистр, прямые черты). */
const HOME = '<HOME>';
const HOME_NORMAL = '<home>';

const normalized = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

interface PathContext {
  home: string;
  platform: NodeJS.Platform;
}

/** Путь под домом → метка + хвост; остальное как есть. Хвост не трогаем — сравнения его байтовые. */
function homeToToken(value: string, { home, platform }: PathContext): string {
  if (!home || value.length < home.length) return value;
  const prefix = value.slice(0, home.length);
  const next = value.charAt(home.length);
  if (next !== '' && next !== '/' && next !== '\\') return value;
  const caseless = platform === 'win32' || platform === 'darwin';
  const same = caseless ? normalized(prefix) === normalized(home) : prefix === home;
  if (!same) return value;
  const token = prefix !== home && prefix === normalized(home) ? HOME_NORMAL : HOME;
  return token + value.slice(home.length);
}

function tokenToHome(value: string, { home, platform }: PathContext): string {
  const token = value.startsWith(HOME) ? HOME : value.startsWith(HOME_NORMAL) ? HOME_NORMAL : '';
  if (!token) return value;
  const base = token === HOME_NORMAL && platform === 'win32' ? normalized(home) : home;
  const rest = value.slice(token.length);
  return base + (platform === 'win32' ? rest : rest.replace(/\\/g, '/'));
}

/** Обход значения: строки и ключи записей — через `map`, секретные ключи — прочь. */
function mapDeep(value: unknown, map: (text: string) => string, dropSecrets: boolean): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, map, dropSecrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // Порядок ключей отсортирован: снимок в git, и перестановка не должна давать дифф.
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (dropSecrets && SECRET_KEY.test(key) && typeof item === 'string' && item !== '') continue;
      out[map(key)] = mapDeep(item, map, dropSecrets);
    }
    return out;
  }
  return value;
}

/** Переносимая часть состояния: только отмеченные поля, без настроек машины и секретов, дом — меткой. */
export function portableOf(state: AppState, context: PathContext): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of PORTABLE_KEYS) {
    if (state[key] !== undefined) picked[key] = state[key];
  }
  if (state.settings) {
    const settings: Record<string, unknown> = { ...state.settings };
    for (const key of LOCAL_SETTINGS) delete settings[key];
    picked.settings = settings;
  }
  return mapDeep(picked, (text) => homeToToken(text, context), true) as Record<string, unknown>;
}

export function snapshotText(state: AppState, context: PathContext): string {
  return `${JSON.stringify({ version: VERSION, state: portableOf(state, context) }, null, 2)}\n`;
}

/**
 * Применить снимок поверх здешнего состояния: переносимые поля — из снимка,
 * здешние и настройки машины — свои. Выключенные правила дополняются, а не
 * заменяются: их текст — единственная копия вынутого из ЗДЕШНЕГО CLAUDE.md.
 */
export function applyPortable(
  local: AppState,
  portable: Partial<AppState>,
  context: PathContext,
): AppState {
  const restored = mapDeep(
    portable,
    (text) => tokenToHome(text, context),
    false,
  ) as Partial<AppState>;
  const next = { ...local } as unknown as Record<string, unknown>;
  for (const key of PORTABLE_KEYS) {
    if (key === 'settings' || key === 'disabledRules') continue;
    if (restored[key] !== undefined) next[key] = restored[key];
  }
  if (restored.settings) {
    const settings: Record<string, unknown> = { ...local.settings, ...restored.settings };
    for (const key of LOCAL_SETTINGS) {
      if (local.settings[key] === undefined) delete settings[key];
      else settings[key] = local.settings[key];
    }
    next.settings = settings;
  }
  const own = local.disabledRules ?? [];
  const taken = new Set(own.map((rule) => rule.title.trim().toLocaleLowerCase()));
  const brought = (restored.disabledRules ?? []).filter(
    (rule) => !taken.has(rule.title.trim().toLocaleLowerCase()),
  );
  if (own.length > 0 || brought.length > 0) next.disabledRules = [...own, ...brought];
  return next as unknown as AppState;
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

function readSeen(appDataDir: string): string {
  try {
    return readFileSync(join(appDataDir, SEEN_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

function markSeen(appDataDir: string, text: string): void {
  writeFileSync(join(appDataDir, SEEN_FILE), `${hashOf(text)}\n`);
}

/** Записать снимок, если переносимое изменилось. Атомарно: git не должен застать полфайла. */
export function writeSnapshotIfChanged(appDataDir: string, text: string): boolean {
  const file = join(appDataDir, SNAPSHOT_FILE);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // нет файла — пишем
  }
  if (current === text) return false;
  const temp = `${file}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
  markSeen(appDataDir, text);
  return true;
}

export type PulledSnapshot =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'pulled'; text: string; state: Partial<AppState> };

/**
 * Снимок, которого эта машина не писала и не применяла, — его принёс git.
 * Испорченный (конфликт слияния, обрыв) не применяется: панель стартует со своим.
 */
export function readPulledSnapshot(appDataDir: string): PulledSnapshot {
  const file = join(appDataDir, SNAPSHOT_FILE);
  if (!existsSync(file)) return { kind: 'none' };
  const text = readFileSync(file, 'utf8');
  if (hashOf(text) === readSeen(appDataDir)) return { kind: 'none' };
  try {
    const parsed = JSON.parse(text) as { version?: unknown; state?: unknown };
    if (parsed.version !== VERSION || !parsed.state || typeof parsed.state !== 'object') {
      return { kind: 'invalid', reason: `unsupported snapshot version ${String(parsed.version)}` };
    }
    return { kind: 'pulled', text, state: parsed.state as Partial<AppState> };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Применённый снимок помечается своим — следующий старт его уже не применяет.
 * Метится то, что лежит в файле СЕЙЧАС: после применения панель могла
 * переписать его своим слиянием, и пометить прочитанный текст значило бы
 * применять собственный файл на каждом старте.
 */
export function acceptSnapshot(appDataDir: string): void {
  const file = join(appDataDir, SNAPSHOT_FILE);
  if (existsSync(file)) markSeen(appDataDir, readFileSync(file, 'utf8'));
}
