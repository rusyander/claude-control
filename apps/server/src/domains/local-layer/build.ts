import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandBraces } from './frontmatter.ts';
import { globToRegExp } from '../project-git/mirror-local.ts';
import { materializeOverride, remapCommand } from './overrides.ts';
import { readCompressed, substitute } from './sections.ts';
import type {
  LayerConfig,
  LocalLayerStatus,
  OverrideStatus,
  TeamLayer,
} from './local-layer.types.ts';

/**
 * Сборка `.agent/local-layer/build/` из командного слоя и `layer.json`:
 *
 * - `instructions.md` — цепочка `CLAUDE.md` с импортами и правила без `paths`,
 *   каждый файл под той же шапкой «Contents of …», что ставит CLI; сжатые куски
 *   подставлены, только если сжаты с текущего оригинала (`sections.ts`);
 * - `rules.json` + `rules/*.md` — правила по путям и вложенные `CLAUDE.md` для
 *   хука `path-rules.mjs`: шаблоны уже переведены в регулярные выражения, хуку
 *   не нужен ни один модуль панели;
 * - `settings.json` — командные настройки (хуки с подменой путей замены,
 *   права, переменные) плюс хук правил по путям; едут `--settings`, который
 *   действует при любом `--setting-sources`;
 * - `plugin/` — навыки, агенты и команды проекта (имя плагина `project`);
 * - `mcp.json` — включённые серверы `.mcp.json`;
 * - `overrides/` — переносимые копии замен.
 */

export const PLUGIN_NAME = 'project';

/** Сколько знаков должно сэкономить сжатие, чтобы слой без замен окупал себя. */
export const MIN_SAVED_CHARS = 500;

export const PATH_RULES_SCRIPT = fileURLToPath(
  new URL('../../../assets/local-layer/path-rules.mjs', import.meta.url),
);

const slash = (path: string): string => path.replaceAll('\\', '/');

/** Шапка куска инструкций — та же, что ставит CLI (проба 18.10.2026). */
export function header(path: string): string {
  return `Contents of ${path} (project instructions, checked into the codebase):`;
}

function hooksOf(settings: Record<string, unknown> | undefined): Record<string, unknown[]> {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return {};
  return Object.fromEntries(
    Object.entries(hooks as Record<string, unknown>).filter(([, list]) => Array.isArray(list)),
  ) as Record<string, unknown[]>;
}

function remapHooks(
  hooks: Record<string, unknown[]>,
  mapped: ReadonlyMap<string, string>,
): { hooks: Record<string, unknown[]>; count: number } {
  let count = 0;
  const out: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(hooks)) {
    out[event] = list.map((group) => {
      if (!group || typeof group !== 'object') return group;
      const entries = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(entries)) return group;
      return {
        ...group,
        hooks: entries.map((hook) => {
          count += 1;
          const command = (hook as { command?: unknown }).command;
          return typeof command === 'string'
            ? { ...(hook as object), command: remapCommand(command, mapped) }
            : hook;
        }),
      };
    });
  }
  return { hooks: out, count };
}

/**
 * Командные настройки поверх локальных едут флагом, а флаг старше локального
 * файла. Чтобы старшинство осталось прежним (локальное > командное), из
 * командных снимаются значения, которые локальный файл задаёт сам; массивы
 * не снимаются — CLI их складывает из всех источников.
 */
export function yieldToLocal(
  team: Record<string, unknown>,
  local: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!local) return team;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(team)) {
    const mine = local[key];
    if (mine === undefined || Array.isArray(value)) {
      out[key] = value;
    } else if (
      value &&
      typeof value === 'object' &&
      mine &&
      typeof mine === 'object' &&
      !Array.isArray(mine)
    ) {
      out[key] = yieldToLocal(value as Record<string, unknown>, mine as Record<string, unknown>);
    }
  }
  return out;
}

export interface BuildInput {
  root: string;
  layerDir: string;
  team: TeamLayer;
  config: LayerConfig;
  local?: Record<string, unknown>;
  caseless: boolean;
}

export interface BuildResult {
  status: Omit<LocalLayerStatus, 'mode' | 'configured' | 'used' | 'reason' | 'root'>;
  /** Командные файлы замыканий замен — входят в отпечаток. */
  closure: string[];
  overridesActive: number;
  savedChars: number;
}

export function buildLayer(input: BuildInput): BuildResult {
  const { root, layerDir, team, config } = input;
  const out = join(layerDir, 'build');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Инструкции: каждый файл под шапкой CLI, сжатые куски — где они свежие.
  const compressed = readCompressed(join(layerDir, 'compressed'));
  const matched = new Set<string>();
  const pending: string[] = [];
  let sections = 0;
  let used = 0;
  let teamChars = 0;
  let layerChars = 0;
  const textOf = (path: string, text: string): string => {
    const result = substitute(slash(relative(root, path)), text, compressed);
    for (const file of result.matched) matched.add(file);
    pending.push(...result.pending);
    sections += result.sections;
    used += result.compressed;
    teamChars += text.length;
    layerChars += result.text.length;
    return result.text;
  };
  const instructions = team.instructions
    .map((entry) => `${header(entry.path)}\n\n${textOf(entry.path, entry.text).trim()}`)
    .join('\n\n\n');
  writeFileSync(join(out, 'instructions.md'), instructions, 'utf8');

  // Правила по путям: текст в файл, шаблоны — регулярками.
  mkdirSync(join(out, 'rules'), { recursive: true });
  const rules = team.pathRules.map((rule, at) => {
    const file = join(out, 'rules', `${String(at).padStart(3, '0')}-${basename(rule.path)}`);
    writeFileSync(file, textOf(rule.path, rule.text).trim(), 'utf8');
    return {
      id: slash(relative(root, rule.path)),
      label: rule.path,
      file,
      base: rule.base,
      patterns: rule.globs.flatMap(expandBraces).map((glob) => globToRegExp(glob).source),
    };
  });
  writeFileSync(
    join(out, 'rules.json'),
    JSON.stringify({ caseless: input.caseless, rules }, null, 2),
    'utf8',
  );

  // Замены хуков.
  const overrides: OverrideStatus[] = [];
  const closure: string[] = [];
  const mapped = new Map<string, string>();
  for (const spec of config.overrides) {
    const made = materializeOverride(root, spec, join(out, 'overrides'));
    overrides.push(made.status);
    closure.push(...made.closure);
    for (const [rel, target] of made.mapped) mapped.set(rel, target);
  }

  // Настройки: командные (со старшинством локальных) + хук правил по путям.
  const remapped = remapHooks(hooksOf(team.settings), mapped);
  const settings: Record<string, unknown> = {
    ...yieldToLocal(team.settings ?? {}, input.local),
    hooks: remapped.hooks,
  };
  delete settings.enableAllProjectMcpServers;
  delete settings.enabledMcpjsonServers;
  delete settings.disabledMcpjsonServers;
  if (rules.length > 0) {
    const hooks = settings.hooks as Record<string, unknown[]>;
    hooks.PostToolUse = [
      ...(hooks.PostToolUse ?? []),
      {
        matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
          {
            type: 'command',
            command: `node "${slash(PATH_RULES_SCRIPT)}" "${slash(join(out, 'rules.json'))}"`,
            timeout: 10,
          },
        ],
      },
    ];
  }
  if (Object.keys(settings.hooks as object).length === 0) delete settings.hooks;
  writeFileSync(join(out, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  // Навыки, агенты, команды — плагином: только так они доезжают без источника `project`.
  const plugin = join(out, 'plugin');
  const pluginItems = team.skills.length + team.agents.length + team.commands.length;
  if (pluginItems > 0) {
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: PLUGIN_NAME,
        version: '0.0.0',
        description: 'Project layer (local copy)',
      }),
      'utf8',
    );
    for (const dir of team.skills)
      cpSync(dir, join(plugin, 'skills', basename(dir)), { recursive: true });
    const claude = join(root, '.claude');
    for (const file of [...team.agents, ...team.commands]) {
      cpSync(file, join(plugin, relative(claude, file)));
    }
  }
  const mcpServers = Object.keys(team.mcp);
  if (mcpServers.length > 0) {
    writeFileSync(join(out, 'mcp.json'), JSON.stringify({ mcpServers: team.mcp }, null, 2), 'utf8');
  }

  const orphans = compressed.filter((item) => !matched.has(item.file)).map((item) => item.file);
  const overridesActive = overrides.filter((item) => item.state === 'active').length;
  return {
    status: {
      builtAt: new Date().toISOString(),
      instructions: {
        files: team.instructions.length,
        teamChars,
        layerChars,
        sections,
        compressed: used,
        pending,
      },
      pathRules: rules.length,
      skills: team.skills.map((dir) => basename(dir)),
      agents: team.agents.length,
      commands: team.commands.length,
      mcpServers,
      hooks: remapped.count,
      overrides,
      orphans,
      excluded: team.excluded.length,
    },
    closure,
    overridesActive,
    savedChars: Math.max(0, teamChars - layerChars),
  };
}

/** Флаги и дописка прогона из готовой сборки. */
export function runArgsOf(layerDir: string): {
  args: string[];
  append: string;
  settings: Record<string, unknown>;
} {
  const out = join(layerDir, 'build');
  const args: string[] = [];
  if (existsSync(join(out, 'plugin', '.claude-plugin', 'plugin.json'))) {
    args.push('--plugin-dir', join(out, 'plugin'));
  }
  if (existsSync(join(out, 'mcp.json'))) args.push('--mcp-config', join(out, 'mcp.json'));
  const read = (name: string): string =>
    existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : '';
  const settingsText = read('settings.json');
  return {
    args,
    append: read('instructions.md'),
    settings: settingsText ? (JSON.parse(settingsText) as Record<string, unknown>) : {},
  };
}
