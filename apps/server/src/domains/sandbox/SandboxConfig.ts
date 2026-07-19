import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readRules } from '../rules.ts';
import { readSkills } from '../skills.ts';
import { readHooks } from '../hooks.ts';
import { readMcpServers } from '../mcp.ts';
import type { ClaudeLocation } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import {
  readClaudeCredentials,
  writeSecretFile,
  type CredentialsSource,
} from '../../lib/credentials.ts';

/**
 * Изолированная конфигурация для проверки отдельных настроек.
 *
 * Claude Code читает всё из каталога, на который указывает CLAUDE_CONFIG_DIR.
 * Песочница пользуется этим: во временный каталог кладётся только то, что
 * проверяют, и ничего больше. Проверено на практике — в таком запуске у Claude
 * 30 инструментов вместо 165, ни одного MCP-сервера и ни одного стороннего
 * хука, а переписка пишется в тот же временный каталог, а не в настоящий.
 *
 * Наружу из песочницы не выходит ничего: настоящие настройки открываются
 * только на чтение, файл с токенами MCP-серверов не копируется, а рабочая
 * папка своя. Единственное исключение — учётные данные Claude Code: без них
 * проверять нечего (см. lib/credentials.ts, там же разница между системами).
 */

/** Что именно проверяем. */
export interface SandboxSelection {
  ruleIds?: string[];
  skillIds?: string[];
  hookIds?: string[];
  mcpIds?: string[];
  /** Файлы скриптов из hooks/, которые нужны выбранным хукам. */
  scriptNames?: string[];
  /** Текст правила, которого ещё нет в настройках, — для проверки черновика. */
  draftRule?: { title: string; text: string };
}

export interface SandboxDescription {
  /** Что попало в песочницу — показывается пользователю перед прогоном. */
  rules: string[];
  skills: string[];
  hooks: string[];
  mcpServers: string[];
  scripts: string[];
}

export interface Sandbox {
  id: string;
  configDir: string;
  workDir: string;
  description: SandboxDescription;
  /**
   * Откуда взялся токен и почему не взялся. Нужно интерфейсу: без токена
   * разговор в песочнице не пойдёт, и причину лучше назвать заранее.
   */
  credentials: { source: CredentialsSource; reason?: string };
  /** Переменные окружения для запуска: сюда попадает ключ API, если доступ им. */
  env: Record<string, string>;
}

/** Корень всех песочниц — намеренно вне каталога Claude Code: туда писать нельзя. */
function sandboxRoot(): string {
  return join(homedir(), '.claude-control', 'sandboxes');
}

export function sandboxPaths(id: string): { root: string; configDir: string; workDir: string } {
  const root = join(sandboxRoot(), id.replace(/[^a-zA-Z0-9-]/g, ''));
  return { root, configDir: join(root, 'config'), workDir: join(root, 'work') };
}

/**
 * Собирает песочницу под выбранные элементы.
 *
 * Учётные данные — единственное, что переносится из настоящего каталога:
 * без них Claude Code отвечает «Not logged in» и проверить ничего нельзя.
 * Файл с токенами MCP-серверов не копируется никогда.
 */
export function createSandbox(
  id: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): Sandbox {
  const { root, configDir, workDir } = sandboxPaths(id);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  // Источник токена зависит от системы: файл на Windows и Linux, связка ключей
  // на macOS. Не нашлось — песочницу всё равно собираем: пусть человек увидит
  // внятную причину в интерфейсе, а не «Not logged in» из недр CLI.
  const credentials = readClaudeCredentials(location.paths.root);
  if (credentials.content) {
    // Именно writeSecretFile: это копия настоящего доступа к аккаунту, и она
    // не должна ни мгновения лежать с правами по умолчанию.
    writeSecretFile(join(configDir, '.credentials.json'), credentials.content);
  }

  const description: SandboxDescription = {
    rules: writeRules(configDir, selection, location, store),
    skills: copySkills(configDir, selection, location, store),
    scripts: [],
    hooks: [],
    mcpServers: [],
  };

  copyScripts(configDir, selection, location, description);

  const settings = buildSettings(configDir, workDir, selection, location, store, description);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  return {
    id,
    configDir,
    workDir,
    description,
    credentials: { source: credentials.source, reason: credentials.reason },
    // Ключ API файлом не кладётся: Claude Code читает его из окружения.
    env: credentials.apiKey ? { ANTHROPIC_API_KEY: credentials.apiKey } : {},
  };
}

export function removeSandbox(id: string): void {
  rmSync(sandboxPaths(id).root, { recursive: true, force: true });
}

/**
 * Пауза, на которую подметание щадит свежие папки: два сервера, стартующие
 * почти одновременно, не должны сносить песочницы друг друга.
 */
const SWEEP_GRACE_MS = 60_000;

/**
 * Подметание при старте. Реестр песочниц живёт только в памяти сервера,
 * поэтому всё, что осталось на диске к моменту запуска, — след аварийного
 * завершения. Внутри такой папки лежит копия `.credentials.json` и значения
 * `env` MCP-серверов открытым текстом, и ждать, пока человек удалит её руками,
 * неправильно.
 */
export function sweepAbandonedSandboxes(
  now: number = Date.now(),
  root: string = sandboxRoot(),
): string[] {
  if (!existsSync(root)) return [];

  const removed: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(root, entry.name);
    if (now - statSync(dir).mtimeMs < SWEEP_GRACE_MS) continue;

    rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }

  return removed;
}

/**
 * Скрипты, выбранные сами по себе, а не через хук. Копия нужна затем же,
 * зачем и хукам: запускать в песочнице надо копию, чтобы запуск не задел
 * настоящий файл и то, что скрипт по дороге пишет.
 */
function copyScripts(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  description: SandboxDescription,
): void {
  if (!selection.scriptNames?.length) return;

  const hooksDir = join(configDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  for (const name of selection.scriptNames) {
    const source = join(location.paths.hooks, name);
    if (!existsSync(source)) continue;

    copyFileSync(source, join(hooksDir, name));
    if (!description.scripts.includes(name)) description.scripts.push(name);
  }
}

/** Правила — это текст в CLAUDE.md, поэтому файл собирается из выбранных. */
function writeRules(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): string[] {
  const parts: string[] = [];
  const names: string[] = [];

  if (selection.ruleIds?.length) {
    const all = readRules(location.paths.claudeMd, store);

    for (const rule of all.filter((item) => selection.ruleIds?.includes(item.id))) {
      parts.push(`## ПРАВИЛО: ${rule.title}\n\n${rule.body}`);
      names.push(rule.title);
    }
  }

  if (selection.draftRule) {
    parts.push(`## ПРАВИЛО: ${selection.draftRule.title}\n\n${selection.draftRule.text}`);
    names.push(`${selection.draftRule.title} (черновик)`);
  }

  if (parts.length > 0) {
    writeFileSync(join(configDir, 'CLAUDE.md'), `${parts.join('\n\n')}\n`, 'utf8');
  }

  return names;
}

/** Скиллы — каталоги, поэтому копируются целиком со всем содержимым. */
function copySkills(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): string[] {
  if (!selection.skillIds?.length) return [];

  const skills = readSkills(location.paths.skills, store).filter((skill) =>
    selection.skillIds?.includes(skill.id),
  );
  if (skills.length === 0) return [];

  mkdirSync(join(configDir, 'skills'), { recursive: true });

  return skills.map((skill) => {
    // Идентификатор скилла — имя его папки, оттуда и копируем целиком:
    // скилл может тянуть за собой references/ и шаблоны.
    const source = join(location.paths.skills, skill.id);
    if (existsSync(source)) {
      cpSync(source, join(configDir, 'skills', skill.id), { recursive: true });
    }
    return skill.name;
  });
}

/**
 * Настройки песочницы: выбранные хуки и MCP-серверы плюс запреты, которые
 * не дают выйти за её пределы.
 */
function buildSettings(
  configDir: string,
  workDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    permissions: { deny: denyRules(location) },
  };

  const hooks = collectHooks(configDir, workDir, selection, location, store, description);
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;

  const servers = collectMcpServers(selection, location, store, description);
  if (Object.keys(servers).length > 0) settings.mcpServers = servers;

  return settings;
}

/**
 * Границы песочницы. Правки и так разрешены только в рабочей папке, но запреты
 * добавляют второй рубеж: настоящую конфигурацию нельзя ни прочитать, ни
 * изменить, а файл с токенами закрыт целиком.
 */
function denyRules(location: ClaudeLocation): string[] {
  const real = location.paths.root.replace(/\\/g, '/');

  return [
    `Read(${real}/.credentials.json)`,
    `Read(${real}/.mcp-secrets.env)`,
    `Edit(${real}/**)`,
    `Write(${real}/**)`,
    'Bash(rm -rf /*)',
    'Bash(shutdown:*)',
  ];
}

/** Хуки: их описания идут в настройки, а файлы скриптов — рядом. */
function collectHooks(
  configDir: string,
  workDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown[]> {
  if (!selection.hookIds?.length) return {};

  const hooksDir = join(configDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const result: Record<string, unknown[]> = {};

  for (const hook of readHooks(location.paths.settings, store)) {
    if (!selection.hookIds.includes(hook.id)) continue;

    let command = hook.command;

    // Скрипт копируем в песочницу и подменяем путь: хук должен запускать
    // копию, иначе правки в песочнице задели бы настоящий файл.
    if (hook.scriptPath && existsSync(hook.scriptPath)) {
      const name = hook.scriptPath.split(/[\\/]/).pop() ?? 'hook.mjs';
      const target = join(hooksDir, name);

      copyFileSync(hook.scriptPath, target);
      command = command.split(hook.scriptPath).join(target);
      description.scripts.push(name);
    }

    const entry = { matcher: hook.matcher ?? '', hooks: [{ type: 'command', command }] };
    result[hook.event] = [...(result[hook.event] ?? []), entry];
    description.hooks.push(`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ''}`);
  }

  // Рабочая папка в переменной окружения — скриптам бывает нужно знать, где
  // они работают, а в песочнице это не настоящий проект.
  process.env.CLAUDE_CONTROL_SANDBOX_WORKDIR = workDir;

  return result;
}

function collectMcpServers(
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown> {
  if (!selection.mcpIds?.length) return {};

  const result: Record<string, unknown> = {};

  for (const server of readMcpServers(location.paths.mcpConfig, store)) {
    if (!selection.mcpIds.includes(server.id)) continue;

    result[server.name] = {
      type: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
    };
    description.mcpServers.push(server.name);
  }

  return result;
}
