import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BackendGuardPartState,
  BackendGuardRule,
  BackendGuardSettings,
  BackendGuardStatus,
  Group,
} from '@agentdeck/contracts';
import { BACKEND_GUARD_RULES } from '@agentdeck/contracts/backend-guard';
import { hookContentId } from '../../lib/hook-id.ts';
import {
  backupEntry,
  readJsonFile,
  removeEntry,
  writeJsonFile,
  writeTextFile,
} from '../../lib/safe-io/safe-io.ts';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import { classifyCall, GUARD_VERSION, type GuardConfig, type GuardHit } from './guard-script.mjs';

/**
 * Защита бэкенда в проекте: файлы, группа и тот же вопрос в брокере прав чата.
 *
 * Ставится в `.claude/` ПРОЕКТА, а не в общие каталоги: метки прода у каждого
 * проекта свои, а хук общего слоя спрашивал бы про `kubectl delete` и там, где
 * это обычная работа. Проектная группа включением файлов не двигает
 * (`collectLeafMembers` её участников пропускает) — значит защита действует во
 * всех прогонах проекта, а группа только собирает её на странице групп.
 */

export const GUARD_EVENT = 'PreToolUse';
/** Bash — команды; MCP — аргументы чужих серверов баз (SQL в поле запроса). */
export const GUARD_MATCHER = 'Bash|mcp__.*';
const SCRIPT_REL = '.claude/hooks/backend-guard.mjs';
const CONFIG_REL = '.claude/backend-guard.json';
const RULE_REL = '.claude/rules/backend-safety.md';
const SETTINGS_REL = '.claude/settings.json';
export const GUARD_RULE_ID = 'backend-safety';
/** `$CLAUDE_PROJECT_DIR` — хук срабатывает и из подкаталога, и в копии ветки. */
export const GUARD_COMMAND = `node "$CLAUDE_PROJECT_DIR/${SCRIPT_REL}"`;
export const GUARD_HOOK_ID = hookContentId(GUARD_EVENT, GUARD_MATCHER, GUARD_COMMAND);

const SOURCE = fileURLToPath(new URL('./guard-script.mjs', import.meta.url));

/** Текст правила — для агента, по-английски, как все правила модели. */
export const GUARD_RULE_TEXT = `# Backend safety

This project has a backend safety guard installed by the panel: a hook asks the human before destructive commands. Do not try to route around it.

- Never run a destructive command without the human's go-ahead in this conversation: DROP or TRUNCATE, DELETE or UPDATE without WHERE, migration rollbacks and resets, terraform/pulumi apply or destroy, kubectl/helm changes, deleting Docker volumes.
- Before such a command say in one line what it destroys and why it is needed, then run it as is so the permission prompt appears. Never disguise it (scripts, base64, variables, aliases) to avoid the prompt.
- Production targets listed in \`.claude/backend-guard.json\` (\`prodMarkers\`) are read-only for you: no writes, migrations or deploys against them, even when a task implies it — stop and ask.
- Prefer the reversible path: a transaction you can roll back, a migration with a down step, a dry run (\`terraform plan\`, \`kubectl diff\`, \`helm diff\`), a backup or snapshot first.
- A refused prompt is final for this task: find another way or ask, do not retry the same command.
`;

interface StoredConfig extends GuardConfig {
  /** Панель сама завела settings.json — при снятии защиты пустой файл уходит. */
  createdSettings?: boolean;
}

interface RawHookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface RawMatcherGroup {
  matcher?: string;
  hooks?: RawHookEntry[];
  [key: string]: unknown;
}
interface RawSettings {
  hooks?: Record<string, RawMatcherGroup[]>;
  [key: string]: unknown;
}

export interface GuardDeps {
  store: AppStore;
  backupDir: string | undefined;
}

/** Файл уходит в копию, потом с диска: «удалить» в панели — всегда с возвратом. */
function archive(path: string, backupDir: string | undefined): void {
  if (!existsSync(path)) return;
  if (backupDir) backupEntry(path, backupDir);
  removeEntry(path);
}

const abs = (root: string, rel: string): string => join(root, ...rel.split('/'));

const scriptSource = (): string => readFileSync(SOURCE, 'utf8');

/** Сравнение без учёта переводов строк: git на Windows мог отдать файл с CRLF. */
const sameText = (a: string, b: string): boolean =>
  a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

function fileState(path: string, expected: string): BackendGuardPartState {
  if (!existsSync(path)) return 'missing';
  try {
    return sameText(readFileSync(path, 'utf8'), expected) ? 'ok' : 'changed';
  } catch {
    return 'changed';
  }
}

const isOurEntry = (entry: RawHookEntry): boolean =>
  typeof entry.command === 'string' && entry.command.includes(SCRIPT_REL);

function hookPresent(settings: RawSettings): boolean {
  return (settings.hooks?.[GUARD_EVENT] ?? []).some(
    (group) => group.matcher === GUARD_MATCHER && (group.hooks ?? []).some(isOurEntry),
  );
}

const knownRule = (value: unknown): value is BackendGuardRule =>
  typeof value === 'string' && (BACKEND_GUARD_RULES as readonly string[]).includes(value);

export function readGuardConfig(root: string): StoredConfig {
  const raw = readJsonFile<unknown>(abs(root, CONFIG_REL), {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as StoredConfig) : {};
}

function settingsOf(config: GuardConfig): BackendGuardSettings {
  return {
    prodMarkers: (config.prodMarkers ?? []).filter((item) => typeof item === 'string'),
    disabled: (config.disabled ?? []).filter(knownRule),
  };
}

function findGroup(groups: readonly Group[], root: string): Group | undefined {
  const target = normalizeProjectPath(resolve(root));
  return groups.find(
    (group) =>
      group.scope?.kind === 'project' &&
      normalizeProjectPath(resolve(group.scope.path)) === target &&
      group.members.some((member) => member.kind === 'hook' && member.id === GUARD_HOOK_ID),
  );
}

export function guardStatus(deps: Pick<GuardDeps, 'store'>, root: string): BackendGuardStatus {
  const settings = readJsonFile<RawSettings>(abs(root, SETTINGS_REL), {});
  const parts = {
    script: fileState(abs(root, SCRIPT_REL), scriptSource()),
    hook: hookPresent(settings) ? ('ok' as const) : ('missing' as const),
    rule: fileState(abs(root, RULE_REL), GUARD_RULE_TEXT),
  };
  const configExists = existsSync(abs(root, CONFIG_REL));
  const anything = parts.script !== 'missing' || parts.hook === 'ok' || parts.rule !== 'missing';
  const whole = parts.script === 'ok' && parts.hook === 'ok' && parts.rule === 'ok' && configExists;
  const group = findGroup(deps.store.getGroups(), root);
  return {
    state: whole ? 'installed' : anything || configExists ? 'partial' : 'none',
    parts,
    settings: settingsOf(readGuardConfig(root)),
    ...(group ? { groupId: group.id, groupName: group.name } : {}),
    files: { script: SCRIPT_REL, settings: SETTINGS_REL, rule: RULE_REL, config: CONFIG_REL },
  };
}

function writeConfig(
  root: string,
  settings: BackendGuardSettings,
  backupDir: string | undefined,
  extra: Partial<StoredConfig>,
): void {
  const previous = readGuardConfig(root);
  const next: StoredConfig = {
    version: GUARD_VERSION,
    lang: extra.lang ?? previous.lang ?? 'ru',
    prodMarkers: [...new Set(settings.prodMarkers.map((item) => item.trim()).filter(Boolean))],
    disabled: [...new Set(settings.disabled)],
    ...(previous.createdSettings || extra.createdSettings ? { createdSettings: true } : {}),
  };
  writeJsonFile(abs(root, CONFIG_REL), next, { backupDir });
}

/** Добавить нашу запись хука, не трогая остальное в settings.json проекта. */
function addHook(root: string, backupDir: string | undefined): boolean {
  const path = abs(root, SETTINGS_REL);
  const created = !existsSync(path);
  const settings = readJsonFile<RawSettings>(path, {});
  if (hookPresent(settings)) return false;
  const hooks = (settings.hooks ??= {});
  const list = (hooks[GUARD_EVENT] ??= []);
  // Первой в списке: чужой хук того же события не должен успеть разрешить вызов раньше.
  list.unshift({ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_COMMAND }] });
  writeJsonFile(path, settings, { backupDir });
  return created;
}

function dropHook(root: string, backupDir: string | undefined, createdSettings: boolean): void {
  const path = abs(root, SETTINGS_REL);
  if (!existsSync(path)) return;
  const settings = readJsonFile<RawSettings>(path, {});
  const list = settings.hooks?.[GUARD_EVENT];
  if (!list || !settings.hooks) return;
  const kept = list
    .map((group) =>
      group.matcher === GUARD_MATCHER
        ? { ...group, hooks: (group.hooks ?? []).filter((entry) => !isOurEntry(entry)) }
        : group,
    )
    .filter((group) => (group.hooks ?? []).length > 0);
  if (kept.length > 0) settings.hooks[GUARD_EVENT] = kept;
  else delete settings.hooks[GUARD_EVENT];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  // Файл заводила сама панель и в нём больше ничего нет — уходит целиком.
  if (createdSettings && Object.keys(settings).length === 0) {
    archive(path, backupDir);
    return;
  }
  writeJsonFile(path, settings, { backupDir });
}

function groupName(root: string, lang: string): string {
  return `${lang === 'en' ? 'Backend guard' : 'Защита бэкенда'} · ${basename(resolve(root))}`;
}

function ensureGroup(store: AppStore, root: string, lang: string): Group {
  const groups = store.getGroups();
  const existing = findGroup(groups, root);
  const scope = { kind: 'project' as const, path: resolve(root), provider: 'claude' };
  const members: Group['members'] = [
    { kind: 'hook', id: GUARD_HOOK_ID, scope },
    { kind: 'rule', id: GUARD_RULE_ID, scope },
  ];
  if (existing) return store.saveGroup({ ...existing, members });
  // Имена групп уникальны без учёта регистра — у второго проекта с тем же
  // именем каталога добавляется номер.
  const taken = new Set(groups.map((group) => group.name.trim().toLocaleLowerCase()));
  const base = groupName(root, lang);
  let name = base;
  for (let index = 2; taken.has(name.toLocaleLowerCase()); index += 1) name = `${base} (${index})`;
  return store.saveGroup({
    id: randomUUID(),
    name,
    description:
      lang === 'en'
        ? 'Asks the human before destructive commands; production targets are read-only for the agent.'
        : 'Спрашивает человека перед разрушительными командами; прод для агента только на чтение.',
    color: 'accent',
    icon: 'lock',
    members,
    env: {},
    projectPaths: [],
    scope,
    isEnabled: true,
    order: groups.reduce((max, group) => Math.max(max, group.order), 0) + 1,
  });
}

/**
 * Поставить или восстановить: скрипт, запись хука, правило, настройки и группа.
 * Каждый файл — с копией до записи; правленый руками скрипт заменяется версией
 * панели (копия старого остаётся в истории изменений).
 */
export function installGuard(
  deps: GuardDeps,
  root: string,
  settings: BackendGuardSettings,
  lang: 'ru' | 'en' = 'ru',
): BackendGuardStatus {
  const { backupDir } = deps;
  writeTextFile(abs(root, SCRIPT_REL), scriptSource(), { backupDir });
  writeTextFile(abs(root, RULE_REL), GUARD_RULE_TEXT, { backupDir });
  const createdSettings = addHook(root, backupDir);
  writeConfig(root, settings, backupDir, { lang, ...(createdSettings ? { createdSettings } : {}) });
  ensureGroup(deps.store, root, lang);
  return guardStatus(deps, root);
}

export function saveGuardSettings(
  deps: GuardDeps,
  root: string,
  settings: BackendGuardSettings,
): BackendGuardStatus {
  writeConfig(root, settings, deps.backupDir, {});
  return guardStatus(deps, root);
}

/** Снять: запись хука, скрипт, правило, настройки и группу. Файлы — в копии. */
export function removeGuard(deps: GuardDeps, root: string): BackendGuardStatus {
  const { backupDir } = deps;
  const config = readGuardConfig(root);
  dropHook(root, backupDir, config.createdSettings === true);
  for (const rel of [SCRIPT_REL, RULE_REL, CONFIG_REL]) {
    archive(abs(root, rel), backupDir);
  }
  const group = findGroup(deps.store.getGroups(), root);
  if (group) deps.store.deleteGroup(group.id);
  return guardStatus(deps, root);
}

/** «Проверить команду» — те же правила, что у хука, на настройках из формы. */
export function checkCommand(
  command: string,
  settings: BackendGuardSettings,
): GuardHit | undefined {
  return classifyCall('Bash', { command }, settings);
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Настройки защиты для каталога прогона: ищем `.claude/backend-guard.json`
 * вверх от `cwd` (чат открыт в подкаталоге монорепы) и, если не нашли, в
 * основной копии (`mainOf` — копия ветки без `.claude/` в git). Не нашли —
 * защиты у проекта нет.
 */
export function guardConfigFor(
  cwd: string,
  mainOf?: (dir: string) => string | undefined,
): GuardConfig | undefined {
  const lookUp = (start: string): GuardConfig | undefined => {
    let dir = resolve(start);
    for (let depth = 0; depth < 12; depth += 1) {
      if (existsSync(abs(dir, CONFIG_REL))) return readGuardConfig(dir);
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    return undefined;
  };
  if (!isDir(cwd)) return undefined;
  const own = lookUp(cwd);
  if (own) return own;
  const main = mainOf?.(cwd);
  return main && main !== cwd ? lookUp(main) : undefined;
}

/**
 * Основная копия по каталогу копии — два вызова git, а брокер спрашивает на
 * каждую команду Bash. Каталог прогона за его жизнь копией быть не перестаёт,
 * поэтому ответ живёт пять минут.
 */
const MAIN_TTL_MS = 5 * 60_000;
const mainCache = new Map<string, { main: string | undefined; at: number }>();

export function cachedMainOf(
  mainOf: (dir: string) => string | undefined,
  clock: () => number = Date.now,
): (dir: string) => string | undefined {
  return (dir) => {
    const now = clock();
    const known = mainCache.get(dir);
    if (known && now - known.at < MAIN_TTL_MS) return known.main;
    const main = mainOf(dir);
    if (mainCache.size > 200) mainCache.clear();
    mainCache.set(dir, { main, at: now });
    return main;
  };
}

/** Брокер прав чата: узнала ли защита проекта этот вызов. */
export function guardHitFor(
  cwd: string | undefined,
  toolName: string,
  input: unknown,
  mainOf?: (dir: string) => string | undefined,
): GuardHit | undefined {
  if (!cwd) return undefined;
  if (toolName !== 'Bash' && !toolName.startsWith('mcp__')) return undefined;
  const config = guardConfigFor(cwd, mainOf);
  return config ? classifyCall(toolName, input, config) : undefined;
}
