import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import {
  CODEX_GROUP_ENV,
  CODEX_KIT_ARG_LIMIT,
  CODEX_KIT_ENV,
  withCodexKit,
} from '../../kit/codex.ts';
import { readHooks } from '../../hooks/hooks.ts';
import { readRules } from '../../rules/rules.ts';
import { codexGroupLayerWriter } from './codex-layer.ts';
import { GroupLayerBlocked } from '../run-layer-parts.ts';

/**
 * Слой групп Codex на прогон: план чистый, запись — только каталог слоя панели,
 * значения секретов MCP — только в окружении процесса (в argv и в файле слоя —
 * одни имена). Сборка запуска (`withCodexKit`): текст человека, набор, группы.
 */

let root: string;
let codexHome: string;
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

const SECRET = 'sk-group-secret-7731';
const HEADER_SECRET = 'Bearer hdr-secret-4410';

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

const input = (groups: Group[]) => ({ providerId: 'codex', cliName: 'Codex', groups });
const planOf = (groups: Group[]) =>
  codexGroupLayerWriter.plan(deps(), input(groups), { env: { CODEX_HOME: codexHome } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-codex-layer-'));
  codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  mkdirSync(join(root, 'skills', 'ladder'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'ladder', 'SKILL.md'),
    '---\nname: ladder\ndescription: ladder skill\n---\n\nBody ladder.\n',
  );
  writeFileSync(join(root, 'CLAUDE.md'), '## ПРАВИЛО: Tests first\n\nWrite GROUP_RULE_42 first.\n');
  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node prompt.js', timeout: 7 }] }],
      },
    }),
  );
  writeFileSync(
    join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        files: {
          command: 'npx',
          args: ['files-mcp', '--root', 'C:\\work'],
          env: { API_KEY: SECRET },
        },
        web: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: HEADER_SECRET },
        },
        old: { type: 'sse', url: 'https://sse.example.com' },
        'my.dotted': { command: 'x' },
      },
    }),
  );
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('codexGroupLayerWriter.plan', () => {
  it('участники по видам: доставлено и отказано с причиной, секрет — не в аргументах', () => {
    const rules = readRules(deps().paths.claudeMd, store);
    const hooks = readHooks(deps().paths.settings, store);
    const prompt = hooks.find((hook) => hook.event === 'UserPromptSubmit')!;
    const pre = hooks.find((hook) => hook.event === 'PreToolUse')!;
    const g = group('a', [
      { kind: 'rule', id: rules[0]!.id },
      { kind: 'skill', id: 'ladder' },
      { kind: 'mcp', id: 'files' },
      { kind: 'mcp', id: 'web' },
      { kind: 'mcp', id: 'old' },
      { kind: 'mcp', id: 'my.dotted' },
      { kind: 'hook', id: prompt.id },
      { kind: 'hook', id: pre.id },
      { kind: 'permission', id: 'Bash(git:*)' },
    ]);
    const plan = planOf([g]);

    expect(plan.delivered.map((item) => item.member)).toEqual([
      `rule:${rules[0]!.id}`,
      'skill:ladder',
      'mcp:files',
      'mcp:web',
      `hook:${prompt.id}`,
    ]);
    expect(plan.refused.map((item) => [item.member, item.code])).toEqual([
      ['mcp:old', 'group-layer-mcp-sse'],
      ['mcp:my.dotted', 'group-layer-mcp-name'],
      [`hook:${pre.id}`, 'group-layer-hook-event'],
      ['permission:Bash(git:*)', 'group-layer-permission'],
    ]);
    const args = plan.payload.mcpArgs.join(' ');
    expect(args).toContain('mcp_servers.files={command="npx"');
    expect(args).toContain('env_vars=["API_KEY"]');
    expect(args).toContain(
      'mcp_servers.web={url="https://mcp.example.com/mcp",env_http_headers={"Authorization"="AGENTDECK_MCP_WEB_AUTHORIZATION"}}',
    );
    expect(args).not.toContain(SECRET);
    expect(args).not.toContain('hdr-secret');
    expect(plan.payload.secrets).toEqual({
      API_KEY: SECRET,
      AGENTDECK_MCP_WEB_AUTHORIZATION: HEADER_SECRET,
    });
    expect(plan.payload.hooks).toEqual([
      { event: 'UserPromptSubmit', command: 'node prompt.js', timeoutMs: 7000 },
    ]);
    expect(plan.payload.rules).toContain('GROUP_RULE_42');
  });

  it('план ничего не пишет: каталога слоёв нет', () => {
    planOf([group('a', [{ kind: 'skill', id: 'ladder' }])]);
    expect(existsSync(join(root, 'agentdeck', 'codex-group-layers'))).toBe(false);
  });

  it('переменная группы с именем секрета MCP и другим значением — отказ, секрет цел', () => {
    const g = group('a', [{ kind: 'mcp', id: 'files' }], { env: { API_KEY: 'other', KEEP: '1' } });
    const plan = planOf([g]);
    expect(plan.env).toEqual({ KEEP: '1' });
    expect(plan.refused).toContainEqual({
      group: 'a',
      member: 'env:API_KEY',
      code: 'group-layer-duplicate',
      params: { id: 'API_KEY', group: 'Group a' },
    });
    expect(plan.payload.secrets.API_KEY).toBe(SECRET);
  });

  it('свой текст человека и правила групп длиннее предела — отказ прогону, не обрезка', () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      `developer_instructions = "${'x'.repeat(CODEX_KIT_ARG_LIMIT)}"\n`,
    );
    const rules = readRules(deps().paths.claudeMd, store);
    expect(() => planOf([group('a', [{ kind: 'rule', id: rules[0]!.id }])])).toThrow(
      GroupLayerBlocked,
    );
  });
});

describe('codexGroupLayerWriter.write + withCodexKit', () => {
  const written = (members: Group['members']) => {
    const plan = planOf([group('a', members)]);
    const out = codexGroupLayerWriter.write(deps(), plan);
    if (!out) throw new Error('nothing written');
    return out;
  };

  it('файл слоя несёт имена, окружение — значения; хуки — надзирателю', () => {
    const hooks = readHooks(deps().paths.settings, store);
    const prompt = hooks.find((hook) => hook.event === 'UserPromptSubmit')!;
    const out = written([
      { kind: 'mcp', id: 'files' },
      { kind: 'mcp', id: 'web' },
      { kind: 'skill', id: 'ladder' },
      { kind: 'hook', id: prompt.id },
    ]);
    const file = out.env[CODEX_GROUP_ENV]!;
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('hdr-secret');
    expect(out.env.API_KEY).toBe(SECRET);
    expect(out.env.AGENTDECK_MCP_WEB_AUTHORIZATION).toBe(HEADER_SECRET);
    expect(existsSync(join(out.dir, 'skills', 'ladder', 'SKILL.md'))).toBe(true);
    expect(out.hooks).toEqual([
      { event: 'UserPromptSubmit', command: 'node prompt.js', timeoutMs: 7000 },
    ]);
  });

  it('запуск: текст человека → набор → группы; MCP и исключения оболочки; корни скиллов', () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      'developer_instructions = "USER_OWN_1"\n[shell_environment_policy]\nexclude = ["AWS_*"]\n',
    );
    const rules = readRules(deps().paths.claudeMd, store);
    const out = written([
      { kind: 'rule', id: rules[0]!.id },
      { kind: 'skill', id: 'ladder' },
      { kind: 'mcp', id: 'files' },
    ]);
    const kitFile = join(root, 'kit-overlay.json');
    writeFileSync(
      kitFile,
      JSON.stringify({
        appServer: 'USER_OWN_1\n\nKIT_RULE_9',
        exec: 'USER_OWN_1\n\nKIT_RULE_9',
        skillsDir: join(root, 'kit-skills'),
      }),
    );
    const env = { ...out.env, [CODEX_KIT_ENV]: kitFile, CODEX_HOME: codexHome };

    const exec = withCodexKit(['exec', '--json', 'prompt'], env, 'exec');
    expect(exec.args[0]).toBe('exec');
    expect(exec.args.at(-1)).toBe('prompt');
    const instructions = exec.args[exec.args.indexOf('-c') + 1]!;
    const own = instructions.indexOf('USER_OWN_1');
    const kit = instructions.indexOf('KIT_RULE_9');
    const rule = instructions.indexOf('GROUP_RULE_42');
    expect(own).toBeGreaterThan(-1);
    expect(own < kit && kit < rule).toBe(true);
    expect(instructions.split('USER_OWN_1')).toHaveLength(2);
    expect(instructions).toContain('agentdeck group skills');
    expect(exec.args).toContain('shell_environment_policy.exclude=["AWS_*","API_KEY"]');
    expect(exec.args.some((arg) => arg.startsWith('mcp_servers.files='))).toBe(true);
    expect(exec.args.join(' ')).not.toContain(SECRET);
    expect(exec.env?.[CODEX_GROUP_ENV]).toBeUndefined();
    expect(exec.env?.[CODEX_KIT_ENV]).toBeUndefined();
    expect(exec.env?.API_KEY).toBe(SECRET);

    const app = withCodexKit(['app-server'], env, 'appServer');
    expect(app.skillRoots).toEqual([join(root, 'kit-skills'), join(out.dir, 'skills')]);
    expect(app.args.join(' ')).not.toContain('agentdeck group skills');
  });

  it('без набора свой текст человека всё равно первым; файл пропал — missing', () => {
    writeFileSync(join(codexHome, 'config.toml'), 'developer_instructions = "USER_OWN_2"\n');
    const rules = readRules(deps().paths.claudeMd, store);
    const out = written([{ kind: 'rule', id: rules[0]!.id }]);
    const env = { ...out.env, CODEX_HOME: codexHome };
    const run = withCodexKit(['exec', 'p'], env, 'exec');
    const text = run.args[2]!;
    expect(text.indexOf('USER_OWN_2')).toBeLessThan(text.indexOf('GROUP_RULE_42'));

    rmSync(out.dir, { recursive: true, force: true });
    expect(withCodexKit(['exec', 'p'], env, 'exec').missing).toBe(true);
  });

  it('набор и группы вместе длиннее предела — отказ с причиной', () => {
    const rules = readRules(deps().paths.claudeMd, store);
    const out = written([{ kind: 'rule', id: rules[0]!.id }]);
    const kitFile = join(root, 'kit-big.json');
    const big = 'k'.repeat(CODEX_KIT_ARG_LIMIT);
    writeFileSync(kitFile, JSON.stringify({ appServer: big, exec: big }));
    const run = withCodexKit(
      ['exec', 'p'],
      { ...out.env, [CODEX_KIT_ENV]: kitFile, CODEX_HOME: codexHome },
      'exec',
    );
    expect(run.refusal).toContain(String(CODEX_KIT_ARG_LIMIT));
  });
});
