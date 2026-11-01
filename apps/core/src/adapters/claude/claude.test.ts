import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import {
  bindClaudeEndpoint,
  CLAUDE_CAPS,
  CLAUDE_CHANNELS,
  createClaudeAdapter,
  planClaude as planWithLayer,
  VENDOR_CREDENTIALS,
} from './claude.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { claudeAbsolutePattern, claudeDenyRules, mapClaudePermission } from './permission.ts';
import { claudeConfigDir, layerHooks, readUserLayer, userLayerFiles } from './user-layer.ts';

/** План доверенного репозитория — слой как просили; недоверенная копия (F-86) — своими случаями. */
const planClaude = (spec: SessionSpec, binding?: Parameters<typeof planWithLayer>[1]) =>
  planWithLayer(spec, binding, trustedLayer(spec));

/** Чистые части переходника Claude Code: привязка адреса, argv/файлы сеанса, права, слой. */

const CHANNEL = CLAUDE_CHANNELS[0]!;
const ENDPOINT = {
  baseUrl: 'http://127.0.0.1:9',
  dialect: 'anthropic-messages' as const,
  model: 'stub-model',
  key: 'k-1',
};
const LIMITS = { windowTokens: 64_000, timeoutMs: 600_000, idleMs: 300_000 };

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(tmpdir(), 'claude-plan-session'),
    cwd: join(tmpdir(), 'claude-plan-work'),
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(tmpdir(), 'claude-plan-core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    ...over,
  };
}

const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe('claude adapter — endpoint binding', () => {
  it('binds base URL, key and model to the session env; limits go to the known env vars', () => {
    const bound = bindClaudeEndpoint(CHANNEL, ENDPOINT, LIMITS);
    expect(bound).toEqual({
      ok: true,
      binding: {
        env: {
          // Прочие учётки вендоров погашены пустым значением (F-09).
          ...Object.fromEntries(
            VENDOR_CREDENTIALS.filter((name) => name !== 'ANTHROPIC_AUTH_TOKEN').map((name) => [
              name,
              '',
            ]),
          ),
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'k-1',
          ANTHROPIC_MODEL: 'stub-model',
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '64000',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '64000',
          CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '600000',
          API_TIMEOUT_MS: '600000',
          CLAUDE_STREAM_IDLE_TIMEOUT_MS: '300000',
          CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: '300000',
        },
        argv: [],
        files: {},
      },
    });
    expect(bindClaudeEndpoint(CHANNEL, ENDPOINT)).toMatchObject({
      ok: true,
      binding: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } },
    });
  });

  it('refuses a dialect or channel the CLI does not have', () => {
    expect(bindClaudeEndpoint(CHANNEL, { ...ENDPOINT, dialect: 'openai-chat' })).toEqual({
      ok: false,
      code: 'no_channel',
    });
    expect(bindClaudeEndpoint({ ...CHANNEL, via: 'argv' } as never, ENDPOINT)).toEqual({
      ok: false,
      code: 'no_channel',
    });
  });

  it('declares one env channel per run-fact channel, per session', () => {
    expect(CLAUDE_CHANNELS).toEqual([
      {
        via: 'env',
        dialect: 'anthropic-messages',
        keyVar: 'ANTHROPIC_AUTH_TOKEN',
        perSession: true,
      },
    ]);
    expect(CLAUDE_CAPS).toMatchObject({
      attribution: true,
      layerControl: true,
      limitsChannel: 'env',
    });
  });
});

describe('claude adapter — launch plan', () => {
  it('layer on: CLI sources as is, own settings/mcp/brief files, session id, fail-closed permissions', () => {
    const plan = planClaude(spec());
    expect(plan.args.slice(0, 10)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-mode',
      'default',
    ]);
    expect(plan.args).not.toContain('--setting-sources');
    expect(plan.args).toContain('--strict-mcp-config');
    expect(after(plan.args, '--session-id')).toBe('33333333-3333-4333-8333-333333333333');
    expect(after(plan.args, '--permission-prompts')).toBe('none');
    expect(plan.args).not.toContain('--disallowedTools');
    expect(after(plan.args, '--settings')).toBe(join(spec().dir, 'claude/settings.json'));
    expect(plan.files['claude/brief.md']).toBe('BRIEF');
    const settings = JSON.parse(plan.files['claude/settings.json']!);
    expect(settings).toEqual({
      permissions: { deny: expect.any(Array), defaultMode: 'default' },
      disableAllHooks: false,
      hooks: {},
    });
    // Без запретов шага остаются только запреты правки настроек Claude Code (F-12).
    expect((settings.permissions.deny as string[]).every((rule) => rule.startsWith('Edit('))).toBe(
      true,
    );
    expect(plan.env).toEqual({ DISABLE_AUTOUPDATER: '1' });
  });

  it('resume, model, effort, permit tool, core hook, read-only tools and MCP servers reach argv and files', () => {
    const plan = planClaude(
      spec({
        resume: { conversationId: 'conv-9' },
        model: 'm-1',
        effort: 'high',
        permitServer: { name: 'agentdeck-permit', tool: 'approve' },
        coreHook: 'node hook.mjs',
        tools: 'read-only',
        deny: {
          paths: [],
          commands: [['git', 'push']],
          mcpTools: ['mcp__forge__merge'],
          tools: ['web'],
        },
        mcpServers: {
          step: { command: 'node', args: ['s.mjs'], env: { A: '1' } },
          plain: { command: 'node', args: [] },
        },
      }),
    );
    expect(after(plan.args, '--resume')).toBe('conv-9');
    expect(plan.args).not.toContain('--session-id');
    expect(after(plan.args, '--model')).toBe('m-1');
    expect(after(plan.args, '--effort')).toBe('high');
    expect(after(plan.args, '--permission-prompt-tool')).toBe('mcp__agentdeck-permit__approve');
    expect(plan.args).not.toContain('--permission-prompts');
    expect(after(plan.args, '--disallowedTools')?.split(',')).toEqual([
      'WebFetch',
      'WebSearch',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'PowerShell',
      'mcp__forge__merge',
      'mcp__agentdeck-permit__approve',
    ]);
    const settings = JSON.parse(plan.files['claude/settings.json']!);
    expect(settings.permissions.deny).toContain('Bash(git push:*)');
    expect(settings.hooks).toEqual({
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook.mjs' }] }],
    });
    expect(JSON.parse(plan.files['claude/mcp.json']!)).toEqual({
      mcpServers: {
        step: { type: 'stdio', command: 'node', args: ['s.mjs'], env: { A: '1' } },
        plain: { type: 'stdio', command: 'node', args: [] },
      },
    });
  });

  it('no model in the spec (CLI default model) → argv carries no --model at all', () => {
    // Модель по умолчанию CLI: ядро её не называет, флаг не пишется вовсе (пустой `--model` — ошибка CLI).
    const plan = planClaude(spec());
    expect(plan.args).not.toContain('--model');
    expect(planClaude(spec({ model: '' })).args).not.toContain('--model');
  });

  it('an effort the CLI does not know and a non-uuid session id are left out', () => {
    const plan = planClaude(spec({ effort: 'turbo', sessionId: 'not-a-uuid' }));
    expect(plan.args).not.toContain('--effort');
    expect(plan.args).not.toContain('--session-id');
  });

  it('layer observe: no CLI sources, the human rules come back through our settings, hooks are recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-layer-'));
    const config = join(root, 'cfg');
    const cwd = join(root, 'work');
    mkdirSync(config, { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(config, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read'], ask: ['Bash'], deny: ['WebFetch', 3] },
        env: { FOO: 'bar', NUM: 1 },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'human.sh' }] }],
          Bad: 'x',
        },
      }),
    );
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{broken');
    const pin = { CLAUDE_CONFIG_DIR: config };
    const observe = planClaude(
      spec({
        cwd,
        layer: { hooks: 'observe', skills: 'on' },
        env: { pin },
        recorder: { command: 'node rec.mjs', log: 'C:\\logs\\r.jsonl' },
        coreHook: 'node core.mjs',
      }),
    );
    expect(after(observe.args, '--setting-sources')).toBe('');
    const observedFile = join(spec({}).dir, 'claude', 'observed-hooks.json');
    const settings = JSON.parse(observe.files['claude/settings.json']!);
    expect(settings.permissions).toEqual({
      allow: ['Read'],
      ask: ['Bash'],
      deny: expect.arrayContaining(['WebFetch']),
      defaultMode: 'default',
    });
    expect(settings.permissions.deny[0]).toBe('WebFetch');
    expect(settings.permissions.deny).not.toContain(3);
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: `node rec.mjs --log "C:\\logs\\r.jsonl" --hook PreToolUse.0.0 --observed "${observedFile}"`,
            timeout: 65,
          },
        ],
      },
      { matcher: '*', hooks: [{ type: 'command', command: 'node core.mjs' }] },
    ]);
    expect(JSON.parse(observe.files['claude/observed-hooks.json']!)).toEqual([
      {
        key: 'PreToolUse.0.0',
        event: 'PreToolUse',
        matcher: 'Bash',
        type: 'command',
        command: 'human.sh',
        sourcePath: join(config, 'settings.json'),
      },
    ]);

    // `off` с записью и хуком ядра, как ставит дорога: хуков человека нет, хук ядра остаётся.
    const off = planClaude(
      spec({
        cwd,
        layer: { hooks: 'off', skills: 'on' },
        env: { pin },
        recorder: { command: 'node rec.mjs', log: 'C:\\logs\\r.jsonl' },
        coreHook: 'node core.mjs',
      }),
    );
    expect(JSON.parse(off.files['claude/settings.json']!).hooks).toEqual({
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node core.mjs' }] }],
    });
    expect(off.files['claude/observed-hooks.json']).toBeUndefined();
  });
});

describe('claude adapter — user layer', () => {
  it('config dir: the CLI variable wins, else the profile home', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg');
    const home = mkdtempSync(join(tmpdir(), 'claude-home-'));
    expect(claudeConfigDir({ HOME: home, USERPROFILE: home })).toBe(join(home, '.claude'));
    expect(userLayerFiles({ CLAUDE_CONFIG_DIR: '/cfg' }, '/w')).toEqual([
      { path: join('/cfg', 'settings.json'), source: 'user', root: '/cfg' },
      { path: join('/w', '.claude', 'settings.json'), source: 'project', root: '/w' },
      { path: join('/w', '.claude', 'settings.local.json'), source: 'project', root: '/w' },
    ]);
  });

  it('a broken file is named unreadable, never read as empty; observe without a recorder records nothing and says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-ul-'));
    const bad = join(root, 'bad.json');
    writeFileSync(bad, 'nope');
    const layer = readUserLayer([bad, join(root, 'absent.json')]);
    expect(layer.unreadable).toEqual([bad]);
    expect(layer.read).toEqual([]);
    const hooks = { Stop: [{ hooks: [{ type: 'command' }] }] };
    const hookFiles = { Stop: ['settings.json'] };
    expect(layerHooks({ ...layer, hooks, hookFiles }, 'observe', undefined, 'obs')).toEqual({
      hooks: {},
      observed: [],
      unrecorded: true,
    });
    const recorded = layerHooks(
      { ...layer, hooks, hookFiles },
      'observe',
      { command: 'rec', log: 'l"og' },
      'o"bs',
    );
    expect(recorded.hooks).toEqual({
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'rec --log "l\\"og" --hook Stop.0.0 --observed "o\\"bs"',
              timeout: 65,
            },
          ],
        },
      ],
    });
    expect(recorded.observed).toEqual([
      {
        key: 'Stop.0.0',
        event: 'Stop',
        matcher: undefined,
        type: 'command',
        command: '',
        sourcePath: 'settings.json',
      },
    ]);
  });
});

describe('claude adapter — permissions', () => {
  it('maps every tool family to a typed ask', () => {
    expect(mapClaudePermission({ tool: 'mcp__s__t', input: {} })).toEqual({
      action: 'mcp',
      target: 'mcp__s__t',
      tool: 'mcp__s__t',
      display: 'mcp__s__t',
    });
    // Цель Grep — корень поиска (cwd), не регулярка (`permission.search.test.ts`).
    expect(mapClaudePermission({ tool: 'Grep', input: { pattern: 'x' } })).toMatchObject({
      action: 'read',
      target: '.',
    });
    expect(mapClaudePermission({ tool: 'LS', input: { path: '/p' } })).toMatchObject({
      target: '/p',
    });
    expect(
      mapClaudePermission({ tool: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }),
    ).toMatchObject({
      action: 'edit',
      target: 'n.ipynb',
      display: 'NotebookEdit n.ipynb',
    });
    expect(mapClaudePermission({ tool: 'Bash', input: { command: 'git  push origin' } })).toEqual({
      action: 'exec',
      target: 'git',
      argv: ['git', 'push', 'origin'],
      argvExact: true,
      tool: 'Bash',
      display: 'git  push origin',
    });
    expect(mapClaudePermission({ tool: 'Bash', input: {} })).toMatchObject({
      target: '',
      argv: [],
    });
    expect(mapClaudePermission({ tool: 'WebSearch', input: { query: 'q' } })).toMatchObject({
      action: 'net',
      target: 'q',
    });
    expect(mapClaudePermission({ tool: 'ExitPlanMode', input: {} })).toEqual({
      action: 'other',
      target: 'ExitPlanMode',
      tool: 'ExitPlanMode',
      display: 'ExitPlanMode',
    });
    // Проба L Q5: подагент — `Agent` (в `init.tools` ещё `Task`), модель — псевдоним в `model`.
    expect(
      mapClaudePermission({
        tool: 'Agent',
        input: { subagent_type: 'Explore', model: 'opus', prompt: 'p' },
      }),
    ).toEqual({
      action: 'subagent',
      target: 'Explore',
      model: 'opus',
      tool: 'Agent',
      display: 'Agent Explore',
    });
    expect(mapClaudePermission({ tool: 'Task', input: { subagent_type: 'x' } })).toMatchObject({
      action: 'subagent',
      target: 'x',
      model: null,
    });
    expect(mapClaudePermission({ tool: 'Skill', input: { skill: 'pdf' } })).toEqual({
      action: 'skill',
      target: 'pdf',
      tool: 'Skill',
      display: 'Skill pdf',
    });
  });

  it('absolute rule paths: POSIX form of a Windows drive, double slash for a root path', () => {
    expect(claudeAbsolutePattern('C:\\Users\\x\\')).toBe('//c/Users/x');
    expect(claudeAbsolutePattern('/home/x')).toBe('//home/x');
    // Относительный путь разрешает вызывающий от cwd (F-36): «от корня» не совпало бы ни с чем.
    expect(() => claudeAbsolutePattern('rel/x')).toThrow(/not absolute/);
  });

  it('deny set: path read+edit with subtree, argv prefix, MCP tools, tool classes', () => {
    expect(
      claudeDenyRules(
        {
          paths: ['/core'],
          commands: [['git', 'push']],
          mcpTools: ['mcp__f__m'],
          tools: ['shell', 'shell'],
        },
        ['shell'],
        '/w',
      ),
    ).toEqual({
      rules: [
        'Read(//core)',
        'Read(//core/**)',
        'Edit(//core)',
        'Edit(//core/**)',
        'Bash(git push:*)',
        'PowerShell(git push:*)',
        'mcp__f__m',
        'Bash',
        'PowerShell',
      ],
      disallowed: ['Bash', 'PowerShell', 'mcp__f__m'],
    });
  });
});

describe('claude adapter — assembled', () => {
  it('carries its caps, the shared SDK permit codec, binding and permission mapping', () => {
    const adapter = createClaudeAdapter();
    expect(adapter.id).toBe('claude');
    expect(adapter.caps).toBe(CLAUDE_CAPS);
    expect(adapter.permitCodec.render({ allow: false, message: 'no' })).toEqual({
      behavior: 'deny',
      message: 'no',
    });
    expect(adapter.bindEndpoint(CHANNEL, ENDPOINT)).toMatchObject({ ok: true });
    expect(adapter.mapPermission({ tool: 'Read', input: { file_path: 'a' } })).toMatchObject({
      action: 'read',
    });
  });
});
