import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import {
  mapQwenPermission,
  qwenDenyRules,
  qwenPathPattern,
  qwenSharePatterns,
} from './permission.ts';
import {
  bindQwenEndpoint,
  createQwenAdapter,
  planQwen as planWithLayer,
  QWEN_CAPS,
  QWEN_CHANNELS,
  qwenHookCommand,
  refuseQwen,
} from './qwen.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';

/** План доверенного репозитория — слой как просили; недоверенная копия (F-86) — своими случаями. */
const planQwen = (spec: SessionSpec, binding: Parameters<typeof planWithLayer>[1]) =>
  planWithLayer(spec, binding, trustedLayer(spec));

/** Чистые части переходника Qwen Code: привязка, системные настройки сеанса, права, отказы. */

const OPENAI = QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!;
const ANTHROPIC = QWEN_CHANNELS.find((c) => c.dialect === 'anthropic-messages')!;
const ENDPOINT = {
  baseUrl: 'http://127.0.0.1:9/',
  dialect: 'openai-chat' as const,
  model: 'stub-model',
  key: 'k-1',
};
const LIMITS = { windowTokens: 64_000, timeoutMs: 600_000, idleMs: 300_000 };
const CWD = join(tmpdir(), 'qwen-plan-work');

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(tmpdir(), 'qwen-plan-session'),
    cwd: CWD,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(CWD, '..', 'qwen-plan-core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on' },
    env: { pin: {} },
    coreHook: 'node hook.mjs core',
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

/**
 * Запреты предков дома ядра (F-13) и формы административной доли (F-126) сверяются в
 * `qwen.fixes.test.ts` — здесь остальные.
 */
const ANCESTOR_RULE = /^read_file\(\.\.(\/\.\.)*\)$/;
const SHARE_RULE = /^(read_file|edit)\(\/\/\//;
const notAncestor = (rules: string[]): string[] =>
  rules.filter((r) => !ANCESTOR_RULE.test(r) && !SHARE_RULE.test(r));

describe('qwen adapter — endpoint binding', () => {
  it('openai-chat: the version path joins the base URL, auth type openai, limits nest under model.generationConfig', () => {
    expect(bindQwenEndpoint(OPENAI, ENDPOINT, LIMITS)).toEqual({
      ok: true,
      binding: {
        env: {
          OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
          OPENAI_API_KEY: 'k-1',
          OPENAI_MODEL: 'stub-model',
        },
        argv: ['--auth-type', 'openai'],
        files: {
          'qwen/system-settings.json': JSON.stringify({
            model: {
              generationConfig: {
                contextWindowSize: 64_000,
                timeout: 600_000,
                streamIdleTimeoutMs: 300_000,
              },
            },
          }),
        },
      },
    });
  });

  it('anthropic-messages: the CLI builds the path itself, auth type anthropic, no limits file without limits', () => {
    expect(
      bindQwenEndpoint(ANTHROPIC, {
        ...ENDPOINT,
        dialect: 'anthropic-messages',
        baseUrl: 'http://h',
      }),
    ).toEqual({
      ok: true,
      binding: {
        env: {
          ANTHROPIC_BASE_URL: 'http://h',
          ANTHROPIC_API_KEY: 'k-1',
          ANTHROPIC_MODEL: 'stub-model',
        },
        argv: ['--auth-type', 'anthropic'],
        files: {},
      },
    });
  });

  it('refuses a mismatched dialect or a non-env channel', () => {
    expect(bindQwenEndpoint(OPENAI, { ...ENDPOINT, dialect: 'anthropic-messages' })).toEqual({
      ok: false,
      code: 'no_channel',
    });
    expect(bindQwenEndpoint({ ...OPENAI, via: 'argv' } as never, ENDPOINT)).toEqual({
      ok: false,
      code: 'no_channel',
    });
    expect(QWEN_CAPS).toMatchObject({
      attribution: false,
      layerControl: false,
      limitsChannel: 'settings-file',
    });
  });
});

describe('qwen adapter — hook command', () => {
  it('strips quotes from quote-free words; a word with whitespace cannot be expressed', () => {
    expect(qwenHookCommand('"C:/node.exe" "C:/x/hook.mjs" core --log "C:/l.jsonl"')).toBe(
      'C:/node.exe C:/x/hook.mjs core --log C:/l.jsonl',
    );
    expect(qwenHookCommand('"C:/Program Files/node.exe" hook.mjs')).toBeNull();
    expect(qwenHookCommand('node ""')).toBeNull();
    expect(qwenHookCommand('   ')).toBeNull();
  });

  it('refuses a layer it cannot control and a core hook it cannot run', () => {
    expect(refuseQwen(spec())).toBeNull();
    expect(refuseQwen(spec({ coreHook: 'node hook.mjs' }))).toBeNull();
    expect(refuseQwen(spec({ layer: { hooks: 'observe' } }))).toMatch(/not controllable/);
    expect(refuseQwen(spec({ coreHook: '"a b/node" x' }))).toMatch(/whitespace/);
  });

  it.runIf(process.platform === 'win32')(
    'a deny path on another drive is held by the core hook or the launch is refused',
    () => {
      const other = CWD.startsWith('C') ? 'D:\\core-home' : 'C:\\core-home';
      const deny = { paths: [other], commands: [], mcpTools: [], tools: [] };
      expect(refuseQwen(spec({ deny, coreHook: undefined }), { unhookedForTests: true })).toBe(
        `deny path on another root and no core hook to guard it: ${other}`,
      );
      expect(refuseQwen(spec({ deny, coreHook: 'node hook.mjs core' }))).toBeNull();
    },
  );
});

describe('qwen adapter — launch plan', () => {
  it('system settings carry deny rules, the core hook and the step servers; the permit server is not one of them', () => {
    const plan = planQwen(
      spec({
        coreHook: '"node" "hook.mjs" core',
        permitServer: { name: 'agentdeck-permit', tool: 'approve' },
        deny: {
          paths: [join(CWD, 'secret')],
          commands: [['git', 'push']],
          mcpTools: ['mcp__f__m'],
          tools: ['web'],
        },
        mcpServers: {
          step: { command: 'node', args: ['s.mjs'], env: { A: '1' } },
          'agentdeck-permit': { command: 'node', args: ['p.mjs'] },
        },
      }),
      null,
    );
    expect(plan.env).toEqual({
      QWEN_CODE_SYSTEM_SETTINGS_PATH: join(spec().dir, 'qwen/system-settings.json'),
    });
    const written = JSON.parse(plan.files['qwen/system-settings.json']!);
    written.permissions.deny = notAncestor(written.permissions.deny);
    expect(written).toEqual({
      permissions: {
        deny: [
          'read_file(./secret)',
          'read_file(./secret/**)',
          'edit(./secret)',
          'edit(./secret/**)',
          'run_shell_command(git push:*)',
          'mcp__f__m',
          'web_fetch',
          'web_search',
        ],
      },
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook.mjs core' }] }],
      },
      mcpServers: { step: { command: 'node', args: ['s.mjs'], env: { A: '1' }, trust: false } },
      // Доверенный репозиторий (F-86): проверка доверия выключена, слой репозитория доходит; хук
      // ядра не снимет ни один файл ниже системного.
      security: { folderTrust: { enabled: false } },
      disableAllHooks: false,
    });
    expect(after(plan.args, '--allowed-mcp-server-names')).toBe('step');
    expect(plan.args).toContain('--append-system-prompt=BRIEF');
    expect(after(plan.args, '--approval-mode')).toBe('default');
    expect(after(plan.args, '--session-id')).toBe('33333333-3333-4333-8333-333333333333');
    expect(plan.args.slice(plan.args.indexOf('--exclude-tools') + 1)).toEqual([
      'web_fetch',
      'web_search',
      'mcp__f__m',
    ]);
  });

  it('no servers: an empty strict list; resume and model reach argv; read-only drops write/edit/shell', () => {
    const plan = planQwen(
      spec({
        resume: { conversationId: 'conv-9' },
        model: 'm-1',
        tools: 'read-only',
        coreHook: undefined,
      }),
      null,
    );
    expect(after(plan.args, '--allowed-mcp-server-names')).toBe('');
    expect(after(plan.args, '--resume')).toBe('conv-9');
    expect(plan.args).not.toContain('--session-id');
    expect(plan.args).toContain('--model=m-1');
    expect(plan.args.slice(plan.args.indexOf('--exclude-tools') + 1)).toEqual([
      'write_file',
      'edit',
      'notebook_edit',
      'run_shell_command',
      'monitor',
    ]);
    const settings = JSON.parse(plan.files['qwen/system-settings.json']!);
    expect(settings.hooks).toBeUndefined();
    expect(planQwen(spec({ sessionId: 'plain' }), null).args).not.toContain('--session-id');
    expect(planQwen(spec(), null).args).not.toContain('--exclude-tools');
  });

  it('the limits fragment of the binding merges into the one system settings file', () => {
    const bound = bindQwenEndpoint(OPENAI, ENDPOINT, LIMITS);
    if (!bound.ok) throw new Error('bind');
    const plan = planQwen(
      spec({ deny: { paths: [], commands: [], mcpTools: [], tools: ['shell'] } }),
      bound.binding,
    );
    const settings = JSON.parse(plan.files['qwen/system-settings.json']!);
    expect(settings.model.generationConfig.contextWindowSize).toBe(64_000);
    expect(notAncestor(settings.permissions.deny)).toEqual(['run_shell_command', 'monitor']);
  });
});

describe('qwen adapter — permissions', () => {
  it('maps every tool family to a typed ask', () => {
    expect(mapQwenPermission({ tool: 'mcp__s__t', input: {} })).toMatchObject({
      action: 'mcp',
      target: 'mcp__s__t',
    });
    // Цель поиска — корень (нет `path` — cwd), не выражение поиска (F-13).
    expect(mapQwenPermission({ tool: 'grep_search', input: { pattern: 'p' } })).toMatchObject({
      action: 'read',
      target: '.',
    });
    expect(mapQwenPermission({ tool: 'list_directory', input: { path: '/d' } })).toMatchObject({
      target: '/d',
    });
    expect(
      mapQwenPermission({ tool: 'notebook_edit', input: { notebook_path: 'n' } }),
    ).toMatchObject({
      action: 'edit',
      target: 'n',
      display: 'notebook_edit n',
    });
    expect(
      mapQwenPermission({ tool: 'run_shell_command', input: { command: "A=1 git push 'o r'" } }),
    ).toMatchObject({
      action: 'exec',
      target: 'git',
      argv: ['git', 'push', 'o r'],
    });
    expect(mapQwenPermission({ tool: 'web_fetch', input: { url: 'http://u' } })).toMatchObject({
      action: 'net',
      target: 'http://u',
    });
    expect(mapQwenPermission({ tool: 'todo_write', input: {} })).toMatchObject({
      action: 'conversation',
      target: 'todo_write',
    });
    expect(mapQwenPermission({ tool: 'agent', input: {} })).toMatchObject({
      action: 'other',
      target: 'agent',
    });
  });

  it('rule paths are relative to the session cwd; another root cannot be expressed', () => {
    expect(qwenPathPattern(CWD, CWD)).toBe('.');
    expect(qwenPathPattern(CWD, join(CWD, 'a', 'b'))).toBe('./a/b');
    expect(qwenPathPattern(CWD, join(CWD, '..', 'home'))).toBe('../home');
    if (process.platform === 'win32') {
      const other = CWD.startsWith('C') ? 'D:\\x' : 'C:\\x';
      expect(qwenPathPattern(CWD, other)).toBeNull();
      // Относительным путь другого диска не выразить; правило есть только у его доли (F-126).
      const shares = qwenSharePatterns(other);
      expect(qwenDenyRules({ paths: [other], commands: [], mcpTools: [], tools: [] }, CWD)).toEqual(
        {
          rules: shares.flatMap((s) => [
            `read_file(${s})`,
            `read_file(${s}/**)`,
            `edit(${s})`,
            `edit(${s}/**)`,
          ]),
          excluded: [],
          unexpressed: [other],
        },
      );
    }
  });
});

describe('qwen adapter — assembled', () => {
  it('refuses the session before spawning anything', async () => {
    const adapter = createQwenAdapter();
    expect(adapter.id).toBe('qwen');
    expect(adapter.caps).toBe(QWEN_CAPS);
    await expect(adapter.launch(spec({ layer: { hooks: 'off' } }))).resolves.toEqual({
      ok: false,
      reason: 'layer off is not controllable',
    });
    await expect(
      adapter.launch(
        spec({
          endpoint: { channel: OPENAI, endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' } },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'endpoint refused: no_channel' });
    expect(() => adapter.usage({ sessionId: 'nope' } as never)).toThrow(/no session nope/);
    expect(adapter.session({ sessionId: 'nope' } as never)).toBeUndefined();
  });
});
