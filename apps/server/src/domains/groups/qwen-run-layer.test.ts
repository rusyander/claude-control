import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { readHooks } from '../hooks.ts';
import { readRules } from '../rules.ts';
import { QWEN_SYSTEM_SETTINGS_ENV } from './qwen-layer.ts';
import { qwenGroupLayerWriter } from './qwen-run-layer.ts';

/**
 * Слой Qwen на прогон из НЕСКОЛЬКИХ групп Claude (выбранная, привязанные,
 * включённые для Qwen): план чистый, запись — только в каталог слоя панели.
 * Скиллы едут нативно (`skills.directories`, P5), правила — `QWEN.md`, хуки —
 * через переходник нагрузки с таймаутом в миллисекундах Qwen.
 */

let root: string;
let store: AppStore;

const deps = () => ({
  store,
  paths: {
    root,
    appData: join(root, 'agentdeck'),
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, 'secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '.claude.json'),
  },
});

interface QwenSettingsShape {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
  context?: { includeDirectories: string[]; loadFromIncludeDirectories: boolean };
  skills?: { directories: string[] };
  model?: unknown;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as QwenSettingsShape;

/** Отпечаток дерева: план не имеет права писать ни байта. */
function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(at, entry.name);
      hash.update(relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function group(id: string, members: Group['members'], extra: Partial<Group> = {}): Group {
  return store.saveGroup({
    id,
    name: `Group ${id}`,
    description: '',
    color: 'accent',
    icon: 'folder',
    members,
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 0,
    ...extra,
  });
}

const input = (groups: Group[]) => ({ providerId: 'qwen', cliName: 'Qwen Code', groups });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-qwen-run-layer-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  for (const id of ['ladder', 'deploy']) {
    mkdirSync(join(root, 'skills', id), { recursive: true });
    writeFileSync(
      join(root, 'skills', id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\nBody ${id}.\n`,
    );
  }
  writeFileSync(join(root, 'skills', 'ladder', 'notes.md'), 'extra file\n');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '## ПРАВИЛО: Tests first\n\nWrite RULE_BODY_42 first.\n\n## ПРАВИЛО: Small diffs\n\nKeep DIFF_RULE_7.\n',
  );
  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js', timeout: 30 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node prompt.js' }] }],
        TeammateIdle: [{ hooks: [{ type: 'command', command: 'node idle.js' }] }],
      },
    }),
  );
  writeFileSync(
    join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: { web: { type: 'http', url: 'https://mcp.example.com', headers: { a: 'b' } } },
      mcpServersDisabled: { files: { command: 'npx', args: ['files-mcp'], env: { K: 'v' } } },
    }),
  );
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('qwenGroupLayerWriter.plan', () => {
  it('ничего не пишет: дерево до и после плана одно и то же', () => {
    const g = group('a', [
      { kind: 'skill', id: 'ladder' },
      { kind: 'mcp', id: 'files' },
    ]);
    const before = treeHash(root);
    const plan = qwenGroupLayerWriter.plan(deps(), input([g]), { env: {} });
    expect(plan.delivered).toHaveLength(2);
    expect(treeHash(root)).toBe(before);
  });

  it('две группы: участники обеих, повтор — первой группе, права и чужое событие — с причиной', () => {
    const rules = readRules(deps().paths.claudeMd, store);
    const hooks = readHooks(deps().paths.settings, store);
    const idle = hooks.find((hook) => (hook.event as string) === 'TeammateIdle')!;
    const first = group(
      'a',
      [
        { kind: 'skill', id: 'ladder' },
        { kind: 'rule', id: rules[0]!.id },
        { kind: 'permission', id: 'Bash(git:*)' },
      ],
      { env: { SHARED: 'from-a', ONLY_A: '1' } },
    );
    const second = group(
      'b',
      [
        { kind: 'skill', id: 'ladder' },
        { kind: 'skill', id: 'deploy' },
        { kind: 'rule', id: rules[1]!.id },
        { kind: 'hook', id: idle.id },
      ],
      { env: { SHARED: 'from-b' } },
    );
    const plan = qwenGroupLayerWriter.plan(deps(), input([first, second]), { env: {} });

    expect(plan.groups).toEqual([
      { id: 'a', name: 'Group a' },
      { id: 'b', name: 'Group b' },
    ]);
    expect(plan.delivered).toEqual([
      { group: 'a', member: 'skill:ladder' },
      { group: 'a', member: `rule:${rules[0]!.id}` },
      { group: 'b', member: 'skill:deploy' },
      { group: 'b', member: `rule:${rules[1]!.id}` },
      { group: 'a', member: 'env:SHARED' },
      { group: 'a', member: 'env:ONLY_A' },
    ]);
    expect(plan.refused).toEqual([
      {
        group: 'a',
        member: 'permission:Bash(git:*)',
        code: 'group-layer-permission',
        params: { cli: 'Qwen Code' },
      },
      {
        group: 'b',
        member: 'skill:ladder',
        code: 'group-layer-duplicate',
        params: { id: 'ladder', group: 'Group a' },
      },
      {
        group: 'b',
        member: `hook:${idle.id}`,
        code: 'group-layer-hook-event-native',
        params: { cli: 'Qwen Code', event: 'TeammateIdle' },
      },
      {
        group: 'b',
        member: 'env:SHARED',
        code: 'group-layer-duplicate',
        params: { id: 'SHARED', group: 'Group a' },
      },
    ]);
    expect(plan.env).toEqual({ SHARED: 'from-a', ONLY_A: '1' });
  });

  it('отпечаток меняется вместе с составом заметки, а не только с файлами', () => {
    const a = group('a', [{ kind: 'skill', id: 'ladder' }]);
    const one = qwenGroupLayerWriter.plan(deps(), input([a]), { env: {} }).digest;
    expect(qwenGroupLayerWriter.plan(deps(), input([a]), { env: {} }).digest).toBe(one);
    const withPermission = group('a', [
      { kind: 'skill', id: 'ladder' },
      { kind: 'permission', id: 'Read' },
    ]);
    expect(qwenGroupLayerWriter.plan(deps(), input([withPermission]), { env: {} }).digest).not.toBe(
      one,
    );
  });
});

describe('qwenGroupLayerWriter.write', () => {
  it('скиллы нативно, правила обеих групп в QWEN.md, MCP, хук через переходник с таймаутом', () => {
    const rules = readRules(deps().paths.claudeMd, store);
    const hooks = readHooks(deps().paths.settings, store);
    const guard = hooks.find((hook) => hook.event === 'PreToolUse')!;
    const prompt = hooks.find((hook) => hook.event === 'UserPromptSubmit')!;
    const a = group('a', [
      { kind: 'skill', id: 'ladder' },
      { kind: 'rule', id: rules[0]!.id },
      { kind: 'hook', id: guard.id },
      { kind: 'mcp', id: 'files' },
    ]);
    const b = group('b', [
      { kind: 'skill', id: 'deploy' },
      { kind: 'rule', id: rules[1]!.id },
      { kind: 'hook', id: prompt.id },
      { kind: 'mcp', id: 'web' },
    ]);
    const plan = qwenGroupLayerWriter.plan(deps(), input([a, b]), { env: {} });
    const written = qwenGroupLayerWriter.write(deps(), plan)!;
    const dir = written.dir;
    expect(dir).toBe(join(root, 'agentdeck', 'qwen-group-layers', plan.digest));
    const settings = readJson(written.env[QWEN_SYSTEM_SETTINGS_ENV]!);

    expect(settings.skills).toEqual({ directories: [join(dir, 'skills')] });
    expect(existsSync(join(dir, 'skills', 'ladder', 'notes.md'))).toBe(true);
    expect(readFileSync(join(dir, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain(
      'Body deploy.',
    );
    const context = readFileSync(join(dir, 'QWEN.md'), 'utf8');
    expect(context).toContain('# Group "Group a"');
    expect(context).toContain('RULE_BODY_42');
    expect(context).toContain('# Group "Group b"');
    expect(context).toContain('DIFF_RULE_7');
    // Перечня скиллов в тексте больше нет: Qwen грузит их сам.
    expect(context).not.toContain('SKILL.md');
    expect(settings.context).toEqual({
      includeDirectories: [dir],
      loadFromIncludeDirectories: true,
    });
    expect(settings.mcpServers).toEqual({
      files: { command: 'npx', args: ['files-mcp'], env: { K: 'v' } },
      web: { httpUrl: 'https://mcp.example.com', headers: { a: 'b' } },
    });

    const guardEntry = settings.hooks!.PreToolUse![0]!;
    expect(guardEntry.matcher).toBe('Bash');
    // 30 секунд Claude → 30000 мс Qwen; у хука без таймаута поля нет.
    expect(guardEntry.hooks[0]!.timeout).toBe(30_000);
    expect(settings.hooks!.UserPromptSubmit![0]!.hooks[0]!.timeout).toBeUndefined();
    const shim = guardEntry.hooks[0]!.command.replace(/^node "?|"?$/g, '');
    expect(shim.startsWith(join(dir, 'hooks').split('\\').join('/'))).toBe(true);
    expect(readFileSync(shim, 'utf8')).toContain('node guard.js');
    expect(existsSync(join(root, '.qwen'))).toBe(false);
  });

  it('системные настройки машины не теряются: слой ложится поверх них', () => {
    const base = join(root, 'system.json');
    writeFileSync(
      base,
      JSON.stringify({
        mcpServers: { corp: { command: 'corp' } },
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'corp-guard' }] }] },
        context: { includeDirectories: ['/corp'] },
        skills: { directories: ['/corp-skills'] },
        model: { name: 'corp-model' },
      }),
    );
    const rules = readRules(deps().paths.claudeMd, store);
    const guard = readHooks(deps().paths.settings, store).find((h) => h.event === 'PreToolUse')!;
    const g = group('a', [
      { kind: 'mcp', id: 'files' },
      { kind: 'hook', id: guard.id },
      { kind: 'skill', id: 'ladder' },
      { kind: 'rule', id: rules[0]!.id },
    ]);
    const env = { [QWEN_SYSTEM_SETTINGS_ENV]: base };
    const written = qwenGroupLayerWriter.write(
      deps(),
      qwenGroupLayerWriter.plan(deps(), input([g]), { env }),
    )!;
    const settings = readJson(written.env[QWEN_SYSTEM_SETTINGS_ENV]!);

    expect(Object.keys(settings.mcpServers!)).toEqual(['corp', 'files']);
    expect(settings.hooks!.PreToolUse).toHaveLength(2);
    expect(settings.context!.includeDirectories).toEqual(['/corp', written.dir]);
    expect(settings.skills!.directories).toEqual(['/corp-skills', join(written.dir, 'skills')]);
    expect(settings.model).toEqual({ name: 'corp-model' });
  });

  it('то же содержимое — тот же каталог; правка участника — новый', () => {
    const g = group('a', [{ kind: 'skill', id: 'ladder' }]);
    const write = () =>
      qwenGroupLayerWriter.write(
        deps(),
        qwenGroupLayerWriter.plan(deps(), input([g]), { env: {} }),
      )!;
    const first = write();
    expect(write().dir).toBe(first.dir);
    writeFileSync(join(root, 'skills', 'ladder', 'notes.md'), 'changed\n');
    expect(write().dir).not.toBe(first.dir);
  });

  it('доставлять файлом нечего: только права — без слоя; только переменные — окружением', () => {
    const rights = group('a', [{ kind: 'permission', id: 'Read' }]);
    const plan = qwenGroupLayerWriter.plan(deps(), input([rights]), { env: {} });
    expect(qwenGroupLayerWriter.write(deps(), plan)).toBeUndefined();

    const envOnly = group('b', [], { env: { FLAG: '1' } });
    const written = qwenGroupLayerWriter.write(
      deps(),
      qwenGroupLayerWriter.plan(deps(), input([envOnly]), { env: {} }),
    );
    expect(written?.env).toEqual({ FLAG: '1' });
    expect(existsSync(join(root, 'agentdeck', 'qwen-group-layers'))).toBe(false);
  });
});
