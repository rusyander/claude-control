import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { DiscoveredMemberKind } from '@agentdeck/contracts/group-sources';
import { readJsonFile, readTextFile } from '../../lib/safe-io/safe-io.ts';
import { maskSecretsInText } from '../../lib/secret-mask/secret-mask.ts';
import { readHooksFromFiles } from '../hooks/hooks.ts';
import { hashDir, hashText, projectClaudeDir } from '../groups/members/members.ts';
import { skillSteps } from '../groups/path/path.ts';
import { splitFrontmatter } from '../skills/frontmatter.ts';

/**
 * Опись источника без модели: что лежит в файлах, одной строкой на предмет.
 * Модель видит только её (и зовётся, только когда её хэш сменился), поэтому
 * здесь всё детерминировано: порядок, хэши, обрезка текстов.
 *
 * Раскладка — Claude'овская. Чужие раскладки проектов (`.gemini`, `.codex`)
 * опись пока не читает: это вопрос владельцу, а выдумывать их — значило бы
 * предлагать наборы из файлов, которые CLI не грузит.
 */

export interface InventoryItem {
  kind: DiscoveredMemberKind;
  id: string;
  path: string;
  summary: string;
  /** Пронумерованные шаги (у скилла с порядком работы). */
  steps: string[];
  hash: string;
}

/** Где искать: каталоги одного источника. Нет поля — раздела у источника нет. */
export interface InventoryLayout {
  skillsDir?: string;
  rulesDir?: string;
  agentsDir?: string;
  commandsDir?: string;
  /** Файлы настроек с хуками: основной и локальный. */
  hookFiles?: { settings: string; local?: string; projectRoot?: string };
  mcpFile?: string;
  instructionFiles?: string[];
}

const MAX_SUMMARY = 160;

function oneLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return (line ?? '').slice(0, MAX_SUMMARY);
}

function frontmatterSummary(raw: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  const description = frontmatter.description;
  return typeof description === 'string' && description.trim()
    ? description.trim().slice(0, MAX_SUMMARY)
    : oneLine(body);
}

function listDirs(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort();
}

function listMd(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => extname(name).toLowerCase() === '.md' && statSync(join(dir, name)).isFile())
    .sort();
}

function skills(dir: string | undefined): InventoryItem[] {
  return listDirs(dir)
    .filter((name) => existsSync(join(dir!, name, 'SKILL.md')))
    .map((name) => {
      const raw = readTextFile(join(dir!, name, 'SKILL.md'));
      return {
        kind: 'skill' as const,
        id: name,
        path: join(dir!, name),
        summary: frontmatterSummary(raw),
        steps: skillSteps(splitFrontmatter(raw).body),
        hash: hashDir(join(dir!, name)),
      };
    });
}

function mdFiles(kind: DiscoveredMemberKind, dir: string | undefined): InventoryItem[] {
  return listMd(dir).map((name) => {
    const raw = readTextFile(join(dir!, name));
    return {
      kind,
      id: basename(name, extname(name)),
      path: join(dir!, name),
      summary: frontmatterSummary(raw),
      steps: [],
      hash: hashText(raw),
    };
  });
}

function hooks(files: InventoryLayout['hookFiles']): InventoryItem[] {
  if (!files) return [];
  return readHooksFromFiles(files.settings, files.local, files.projectRoot).map((hook) => ({
    kind: 'hook' as const,
    id: hook.id,
    path: hook.source === 'settings-local' && files.local ? files.local : files.settings,
    // Команда уходит модели и в кэш поиска: токен из аргументов — маской, до обрезки.
    summary: maskSecretsInText(
      `${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ''}: ${hook.command}`,
    ).slice(0, MAX_SUMMARY),
    steps: [],
    hash: hashText(`${hook.event}\0${hook.matcher ?? ''}\0${hook.command}`),
  }));
}

function mcp(file: string | undefined): InventoryItem[] {
  if (!file || !existsSync(file)) return [];
  const servers =
    readJsonFile<{ mcpServers?: Record<string, Record<string, unknown>> }>(file, {}).mcpServers ??
    {};
  return Object.keys(servers)
    .sort()
    .map((id) => {
      const server = servers[id] ?? {};
      const target = [server.command, server.url].find((value) => typeof value === 'string');
      return {
        kind: 'mcp' as const,
        id,
        path: file,
        summary: maskSecretsInText(String(target ?? '')).slice(0, MAX_SUMMARY),
        steps: [],
        // Хэш без значений окружения: там живут токены, и они не повод
        // заново звать модель.
        hash: hashText(JSON.stringify({ ...server, env: Object.keys(server.env ?? {}) })),
      };
    });
}

function instructions(files: string[] | undefined): InventoryItem[] {
  return (files ?? [])
    .filter((file) => existsSync(file))
    .map((file) => {
      const raw = readTextFile(file);
      return {
        kind: 'instructions' as const,
        id: basename(file),
        path: file,
        summary: oneLine(raw),
        steps: [],
        hash: hashText(raw),
      };
    });
}

/** Опись по раскладке; битый раздел — пустой раздел, а не отказ всей описи. */
export function readInventory(layout: InventoryLayout): InventoryItem[] {
  const safe = (read: () => InventoryItem[]): InventoryItem[] => {
    try {
      return read();
    } catch {
      return [];
    }
  };
  return [
    ...safe(() => skills(layout.skillsDir)),
    ...safe(() => mdFiles('rule', layout.rulesDir)),
    ...safe(() => hooks(layout.hookFiles)),
    ...safe(() => mdFiles('agent', layout.agentsDir)),
    ...safe(() => mdFiles('command', layout.commandsDir)),
    ...safe(() => mcp(layout.mcpFile)),
    ...safe(() => instructions(layout.instructionFiles)),
  ];
}

/** Раскладка Claude в проекте. */
export function projectLayout(root: string): InventoryLayout {
  const dir = projectClaudeDir(root);
  return {
    skillsDir: join(dir, 'skills'),
    rulesDir: join(dir, 'rules'),
    agentsDir: join(dir, 'agents'),
    commandsDir: join(dir, 'commands'),
    hookFiles: {
      settings: join(dir, 'settings.json'),
      local: join(dir, 'settings.local.json'),
      projectRoot: root,
    },
    mcpFile: join(root, '.mcp.json'),
    instructionFiles: [join(root, 'CLAUDE.md'), join(root, 'AGENTS.md')],
  };
}

/** Хэш описи: меняется, только когда поменялся какой-то предмет или их состав. */
export function inventoryHash(items: readonly InventoryItem[]): string {
  return hashText(
    items
      .map((item) => `${item.kind}:${item.id}:${item.hash}`)
      .sort()
      .join('\n'),
  );
}

/**
 * Бюджет описи на один вызов, символов. Опись — сводки, а не тела файлов:
 * у настоящего `~/.claude` владельца (58 предметов) это ~13 тыс. символов.
 * Больше бюджета — опись режется на части, по вызову на часть: длинный вход
 * дешёвой модели кончается оборванным или пустым ответом, а не находками.
 */
export const MAX_INVENTORY_CHARS = 24_000;
/** Шагов скилла в описи: для узнавания порядка работы хватает начала. */
const MAX_LISTED_STEPS = 12;
const MAX_STEP_TITLE = 80;

function itemText(item: InventoryItem): string {
  const head = `- ${item.kind} ${item.id}: ${item.summary}`;
  if (item.steps.length === 0) return head;
  const steps = item.steps
    .slice(0, MAX_LISTED_STEPS)
    .map((step, index) => `    ${index + 1}. ${step.slice(0, MAX_STEP_TITLE)}`);
  return [head, ...steps].join('\n');
}

/** Опись строками для модели: вид, id, сводка и шаги скилла. */
export function inventoryText(items: readonly InventoryItem[]): string {
  return items.map(itemText).join('\n');
}

/** Опись частями не длиннее бюджета, порядок предметов сохраняется. */
export function chunkInventory(
  items: readonly InventoryItem[],
  budget: number = MAX_INVENTORY_CHARS,
): InventoryItem[][] {
  const chunks: InventoryItem[][] = [];
  let current: InventoryItem[] = [];
  let size = 0;
  for (const item of items) {
    const length = itemText(item).length + 1;
    if (current.length > 0 && size + length > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
