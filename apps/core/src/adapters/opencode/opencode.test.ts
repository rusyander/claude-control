import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import {
  bindOpencodeEndpoint,
  OPENCODE_CAPS,
  OPENCODE_CHANNELS,
  OPENCODE_FILES,
  opencodeLayer,
  opencodePermission,
  opencodeReadLayer,
  planOpencode,
  refuseOpencode,
} from './opencode.ts';
import { mapOpencodePermission, OPENCODE_PERMIT_CODEC, opencodeToolName } from './permission.ts';
import { opencodePluginSource } from './plugin.ts';

const HOOK = '"C:\\n\\node.exe" "--experimental-strip-types" "C:\\c\\run.ts" hook';

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: 's',
    dir: 'C:\\sess\\s1',
    cwd: 'C:\\w',
    brief: 'B',
    deny: { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] },
    platform: { coreHome: 'C:\\core', tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 'st',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'x',
    },
    coreHook: HOOK,
    endpoint: {
      channel: OPENCODE_CHANNELS[0]!,
      endpoint: {
        baseUrl: 'http://127.0.0.1:9/',
        dialect: 'openai-chat',
        model: 'stub-model',
        key: 'k',
      },
    },
    ...over,
  };
}

const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

describe('opencode session files and refusals', () => {
  it('binds the endpoint as config text in the session env only (no files, /v1 base)', () => {
    const got = bindOpencodeEndpoint(OPENCODE_CHANNELS[0]!, spec().endpoint!.endpoint);
    if (!got.ok) throw new Error('bind refused');
    expect(got.binding.files).toEqual({});
    expect(Object.keys(got.binding.env)).toEqual(['OPENCODE_CONFIG_CONTENT']);
    const config = JSON.parse(got.binding.env.OPENCODE_CONFIG_CONTENT!) as {
      provider: Record<string, { options: { baseURL: string; apiKey: string } }>;
      enabled_providers: string[];
    };
    expect(Object.values(config.provider)[0]!.options).toEqual({
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
    });
    expect(config.enabled_providers).toHaveLength(1);
    expect(
      bindOpencodeEndpoint(
        { ...OPENCODE_CHANNELS[0]!, dialect: 'anthropic-messages' },
        { ...spec().endpoint!.endpoint, dialect: 'anthropic-messages' },
      ),
    ).toEqual({ ok: false, code: 'no_channel' });
  });

  it('plan: every home and file inside the session dir; repo config, Claude layer, skills off', () => {
    const s = spec({
      mcpServers: {
        panel: { command: 'x', args: ['-y'], env: { K: 'v' } },
        'agentdeck-permit': { command: 'p', args: [] },
      },
      permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    });
    const plan = planOpencode(s, null, opencodeLayer(s));
    expect(plan.args).toEqual(['acp']);
    for (const key of [
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
    ]) {
      expect(inside(s.dir, plan.env[key]!), key).toBe(true);
    }
    expect(plan.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      // Пустую строку opencode 1.18 отвергает ошибкой схемы — только явное «нет».
      OPENCODE_PURE: 'false',
    });
    expect(Object.keys(plan.files).sort()).toEqual(
      [OPENCODE_FILES.config, OPENCODE_FILES.plugin].sort(),
    );
    for (const file of Object.keys(plan.files)) expect(inside(s.dir, join(s.dir, file))).toBe(true);
    const config = JSON.parse(plan.files[OPENCODE_FILES.config]!) as {
      plugin: string[];
      permission: Record<string, string>;
      mcp: Record<string, unknown>;
    };
    // Серверы шага — ключом `mcp` конфига сеанса; запись сервера права не переносится.
    expect(config.mcp).toEqual({
      panel: { type: 'local', command: ['x', '-y'], environment: { K: 'v' }, enabled: true },
    });
    expect(config.plugin).toEqual([pathToFileURL(join(s.dir, OPENCODE_FILES.plugin)).href]);
    expect(config.permission).toEqual(opencodePermission(s));
    expect(plan.files[OPENCODE_FILES.plugin]).toBe(opencodePluginSource(HOOK));
    expect(plan.layerLosses).toBeUndefined();
  });

  it('permission rules: write/shell ask (the core judges), read-only removes them', () => {
    expect(opencodePermission(spec())).toEqual({
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
      external_directory: 'ask',
    });
    const ro = spec({ deny: { ...spec().deny, tools: [...READ_ONLY_DENIED] } });
    expect(opencodePermission(ro)).toMatchObject({ edit: 'deny', bash: 'deny' });
  });

  it('refuses: no core hook, no endpoint (own login in the human data home), a resume', () => {
    expect(refuseOpencode(spec({ coreHook: undefined }))).toMatch(/^no core hook/);
    expect(refuseOpencode(spec({ endpoint: undefined }))).toMatch(/routed endpoint/);
    expect(refuseOpencode(spec({ resume: { conversationId: 'x' } }))).toMatch(/does not resume/);
    expect(refuseOpencode(spec())).toBeNull();
  });

  it('layer, read layer and caps: only the proven is claimed', () => {
    expect(opencodeLayer(spec())).toMatchObject({
      asked: 'on',
      ran: 'off',
      repoLayer: false,
      losses: [expect.stringMatching(/no layer control/)],
    });
    expect(
      opencodeReadLayer({ XDG_DATA_HOME: 'D:\\d', XDG_CONFIG_HOME: 'D:\\c' }).credentials,
    ).toEqual([join('D:\\d', 'opencode', 'auth.json'), join('D:\\c', 'opencode')]);
    expect(OPENCODE_CAPS).toMatchObject({
      preToolHooks: true,
      stream: true,
      attribution: true,
      resume: false,
      // Серверы шага ключом `mcp` конфига сеанса, живая проба opencode.mcp (s10 p6).
      mcp: true,
      strictMcp: true,
      denyOverlay: false,
      images: false,
      subagents: false,
    });
  });
});

describe('opencode core hook plugin (generated module, real child processes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-plugin-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const q = (p: string): string => `"${p}"`;

  async function gate(script: string): Promise<(tool: string, args: object) => Promise<void>> {
    const hook = join(dir, `hook-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(hook, script);
    const file = join(dir, `plugin-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, opencodePluginSource(`${q(process.execPath)} ${q(hook)}`));
    const mod = (await import(pathToFileURL(file).href)) as {
      AgentdeckCoreHook: () => Promise<Record<string, (i: object, o: object) => Promise<void>>>;
    };
    const hooks = await mod.AgentdeckCoreHook();
    return (tool, args) =>
      hooks['tool.execute.before']!({ tool, sessionID: 's', callID: 'c1' }, { args });
  }

  it('passes the call in PreToolUse form with --json; empty answer allows', async () => {
    const log = join(dir, 'seen.json');
    const run = await gate(
      `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), call: JSON.parse(readFileSync(0, 'utf8')) }));`,
    );
    await expect(run('bash', { command: 'git status' })).resolves.toBeUndefined();
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({
      argv: ['--json'],
      call: {
        hook_event_name: 'PreToolUse',
        tool_name: 'bash',
        tool_input: { command: 'git status' },
        tool_call_id: 'c1',
      },
    });
  }, 30_000);

  it('a JSON deny throws its reason; a crash, a non-JSON answer or a missing hook deny too', async () => {
    const deny = await gate(
      `process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Denied by the platform: publish' } }));`,
    );
    await expect(deny('bash', { command: 'git push' })).rejects.toThrow(
      'Denied by the platform: publish',
    );
    const crash = await gate(`process.exit(1);`);
    await expect(crash('bash', {})).rejects.toThrow(/core hook exited 1; denied/);
    const junk = await gate(`process.stdout.write('ok');`);
    await expect(junk('bash', {})).rejects.toThrow(/without a decision; denied/);
    const allowJson = await gate(
      `process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));`,
    );
    // Ответ не «пусто» и не отказ — решения нет: отказ (разрешает только пустой вывод).
    await expect(allowJson('bash', {})).rejects.toThrow(/without a decision; denied/);
    const file = join(dir, 'missing-plugin.mjs');
    writeFileSync(file, opencodePluginSource(`${q(process.execPath)} ${q(join(dir, 'nope.mjs'))}`));
    const mod = (await import(pathToFileURL(file).href)) as {
      AgentdeckCoreHook: () => Promise<Record<string, (i: object, o: object) => Promise<void>>>;
    };
    const hooks = await mod.AgentdeckCoreHook();
    await expect(hooks['tool.execute.before']!({ tool: 'bash' }, { args: {} })).rejects.toThrow(
      /denied/,
    );
  }, 60_000);
});

describe('opencode permission vocabulary', () => {
  it('bash → exec; edit/write with a path → edit, without → other; read with a range', () => {
    expect(
      mapOpencodePermission({ tool: 'bash', input: { command: 'git push origin main' } }),
    ).toMatchObject({
      action: 'exec',
      target: 'git',
      argv: ['git', 'push', 'origin', 'main'],
    });
    expect(mapOpencodePermission({ tool: 'edit', input: { filePath: 'a.ts' } })).toMatchObject({
      action: 'edit',
      target: 'a.ts',
    });
    expect(mapOpencodePermission({ tool: 'patch', input: { patchText: 'x' } })).toMatchObject({
      action: 'other',
    });
    expect(
      mapOpencodePermission({ tool: 'read', input: { filePath: 'a.ts', offset: 5 } }),
    ).toMatchObject({
      action: 'read',
      target: 'a.ts',
      range: { offset: 5, limit: null },
    });
    expect(mapOpencodePermission({ tool: 'read', input: { filePath: 'a.ts' } })).toMatchObject({
      range: null,
    });
  });

  it('list tools read, webfetch is net, task a subagent, skill a skill, unknown other', () => {
    expect(mapOpencodePermission({ tool: 'grep', input: { path: 'src' } })).toMatchObject({
      action: 'read',
      target: 'src',
    });
    expect(mapOpencodePermission({ tool: 'glob', input: {} })).toMatchObject({ target: '.' });
    expect(mapOpencodePermission({ tool: 'webfetch', input: { url: 'https://x' } })).toMatchObject({
      action: 'net',
      target: 'https://x',
    });
    expect(
      mapOpencodePermission({ tool: 'task', input: { subagent_type: 'explore' } }),
    ).toMatchObject({
      action: 'subagent',
      target: 'explore',
    });
    expect(mapOpencodePermission({ tool: 'skill', input: { name: 's1' } })).toMatchObject({
      action: 'skill',
      target: 's1',
    });
    expect(mapOpencodePermission({ tool: 'invalid', input: {} })).toMatchObject({
      action: 'other',
    });
  });

  it('tool name is the ACP title; codec renders accept/decline only', () => {
    expect(opencodeToolName({ title: 'bash' })).toBe('bash');
    expect(opencodeToolName({})).toBe('unknown');
    expect(OPENCODE_PERMIT_CODEC.render({ allow: true, input: {} })).toEqual({
      decision: 'accept',
    });
    expect(OPENCODE_PERMIT_CODEC.render({ allow: false, message: 'no' })).toEqual({
      decision: 'decline',
    });
  });
});
