import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LayerRun, SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planQwen, QWEN_LAYER, refuseQwen } from './qwen.ts';

/**
 * План Qwen Code по слою НА ДЕЛЕ (F-86): `observe` у Qwen нет, безопасный режим CLI гасит MCP ядра
 * (H2) — проверка доверия выключена в обоих планах, слой копии ядро разбирает само
 * (`repo-layer.ts`): держит, исключает или отказывает запуском.
 */

const CWD = join(tmpdir(), 'qwen-layer-work');
const DIR = join(tmpdir(), 'qwen-layer-session');

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: DIR,
    cwd: CWD,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(CWD, '..', 'qwen-layer-core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
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

const UNTRUSTED: LayerRun = { asked: 'on', ran: 'on', repoLayer: false, trust: 'none' };

describe('qwen adapter — F-86 the layer the plan is built for', () => {
  it('F-86: the policy keeps the mode (no observe in Qwen); the downgrade is the repo layer', () => {
    expect(QWEN_LAYER.untrusted('on')).toBe('on');
    expect(QWEN_LAYER.untrusted('off')).toBe('off');
  });

  it('H2: untrusted → folderTrust OFF (the CLI safe mode starts no MCP server, the core one too), IDE off, no session trust record, hooks pinned on', () => {
    const plan = planQwen(spec(), null, UNTRUSTED);
    const settings = JSON.parse(plan.files['qwen/system-settings.json']!);
    expect(settings.security).toEqual({ folderTrust: { enabled: false } });
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.ide).toEqual({ enabled: false });
    expect(Object.keys(plan.files)).toEqual(['qwen/system-settings.json']);
    expect(plan.env).toEqual({
      QWEN_CODE_SYSTEM_SETTINGS_PATH: join(DIR, 'qwen/system-settings.json'),
    });
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('node hook.mjs core');
    // Слоя в копии нет — снимать нечего, `.env` не исключается.
    expect(settings.advanced).toBeUndefined();
  });

  it('F-86: trusted → folderTrust off, hooks pinned on (a repo or human disableAllHooks cannot drop the core hook), no IDE line', () => {
    const plan = planQwen(spec(), null, trustedLayer(spec()));
    const settings = JSON.parse(plan.files['qwen/system-settings.json']!);
    expect(settings.security).toEqual({ folderTrust: { enabled: false } });
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.ide).toBeUndefined();
    expect(Object.keys(plan.files)).toEqual(['qwen/system-settings.json']);
  });

  it("F-86: untrusted → the source repo's permissions.deny + tools.exclude (JSONC) go into system settings; core tool rules dropped", () => {
    const base = mkdtempSync(join(tmpdir(), 'qwen-repo-deny-'));
    const source = join(base, 'source');
    mkdirSync(join(source, '.qwen'), { recursive: true });
    writeFileSync(
      join(source, '.qwen', 'settings.json'),
      [
        '{ // repo',
        '  "permissions": { "deny": ["run_shell_command(mkdir:*)", "mcp__agentdeck-permit__approve"] },',
        '  "tools": { "exclude": ["read_file(/secret.txt)"] }, /* x */',
        '  "hooks": { "PreToolUse": [] }, "env": { "R": "1" }',
        '}',
      ].join('\n'),
    );
    const s = spec({
      cwd: join(base, 'copy'),
      trust: { sourceRepo: source, panelMark: false },
      permitServer: { name: 'agentdeck-permit', tool: 'approve' },
    });
    const plan = planQwen(s, null, UNTRUSTED);
    const settings = JSON.parse(plan.files['qwen/system-settings.json']!);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['run_shell_command(mkdir:*)', 'read_file(/secret.txt)']),
    );
    expect(settings.permissions.deny).not.toContain('mcp__agentdeck-permit__approve');
    expect(settings.env).toBeUndefined();
    expect(JSON.stringify(settings.hooks)).not.toContain('"PreToolUse":[]');
    expect(plan.layerDetail).toMatch(
      /^2 repo deny rules carried from .*; dropped \(would deny core tools\): mcp__agentdeck-permit__approve$/,
    );
    // Доверенный: CLI читает файл репозитория сам — ядро его не несёт.
    const trusted = planQwen(s, null, trustedLayer(s));
    expect(trusted.layerDetail).toBeUndefined();
    expect(JSON.parse(trusted.files['qwen/system-settings.json']!).permissions.deny).not.toContain(
      'run_shell_command(mkdir:*)',
    );
  });

  it('F-86: untrusted → an unparseable repo file (trailing comma, as the CLI) refuses; trusted does not read it', () => {
    const base = mkdtempSync(join(tmpdir(), 'qwen-repo-deny-'));
    const source = join(base, 'source');
    mkdirSync(join(source, '.qwen'), { recursive: true });
    writeFileSync(join(source, '.qwen', 'settings.json'), '{"permissions":{"deny":["a",]}}');
    const s = spec({ cwd: join(base, 'copy'), trust: { sourceRepo: source, panelMark: false } });
    expect(refuseQwen(s, {}, UNTRUSTED)).toMatch(
      /^repo settings unreadable, their deny rules would be lost: .*settings\.json: not JSON/,
    );
    expect(refuseQwen(s, {}, trustedLayer(s))).toBeNull();
  });
});
