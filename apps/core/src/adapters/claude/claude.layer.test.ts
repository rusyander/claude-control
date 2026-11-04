import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LayerRun, SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planClaude, refuseClaude } from './claude.ts';

/**
 * План и отказ Claude Code по слою НА ДЕЛЕ (F-86): недоверенная копия идёт `observe`, файлы
 * репозитория (`.claude/settings*.json`) не читаются ни ядром, ни CLI; слой человека остаётся.
 */

const UNTRUSTED: LayerRun = {
  asked: 'on',
  ran: 'observe',
  repoLayer: false,
  trust: 'none',
  detail: 'no mark',
};

function stand(): { cwd: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-layer-'));
  const cwd = join(root, 'work');
  const config = join(root, 'cfg');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, 'settings.json'),
    JSON.stringify({ env: { HUMAN_VAR: 'h' }, permissions: { deny: ['WebFetch'] } }),
  );
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      env: { REPO_VAR: 'r' },
      permissions: { deny: ['Bash(rm:*)'] },
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'repo.sh' }] }] },
    }),
  );
  writeFileSync(
    join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { LOCAL: 'l' } }),
  );
  return { cwd, config };
}

function spec(cwd: string, config: string, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(cwd, '..', 'session'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: { CLAUDE_CONFIG_DIR: config } },
    coreHook: 'node core.mjs',
    recorder: { command: 'node rec.mjs', log: join(cwd, '..', 'rec.jsonl') },
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

const settingsOf = (plan: ReturnType<typeof planClaude>) =>
  JSON.parse(plan.files['claude/settings.json']!) as {
    env?: Record<string, string>;
    permissions: { deny: string[] };
    hooks: Record<string, unknown[]>;
  };

describe('claude adapter — F-86 the layer the plan is built for', () => {
  it('F-86: untrusted copy asked `on` → CLI sources off, repo env/hooks absent, repo deny carried as data, human layer kept, core hook stays', () => {
    const { cwd, config } = stand();
    const plan = planClaude(spec(cwd, config), null, UNTRUSTED);
    expect(plan.args[plan.args.indexOf('--setting-sources') + 1]).toBe('');
    const settings = settingsOf(plan);
    expect(settings.env).toEqual({ HUMAN_VAR: 'h' });
    expect(settings.permissions.deny).toContain('WebFetch');
    expect(settings.permissions.deny).toContain('Bash(rm:*)');
    expect(plan.layerDetail).toBe(
      `1 repo deny rules carried from ${join(cwd, '.claude', 'settings.json')}, ${join(cwd, '.claude', 'settings.local.json')}`,
    );
    expect(JSON.stringify(settings.hooks)).not.toContain('repo.sh');
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'node core.mjs' }] },
    ]);
    expect(plan.files['claude/observed-hooks.json']).toBeUndefined();
  });

  it('F6: sources user → `--setting-sources user`, repo env/hooks absent, human layer kept; an empty brief drops the brief flag', () => {
    const { cwd, config } = stand();
    const userSpec = spec(cwd, config, {
      brief: '',
      layer: { hooks: 'on', skills: 'on', sources: 'user' },
    });
    const run: LayerRun = {
      asked: 'on',
      ran: 'on',
      repoLayer: false,
      trust: 'none',
      detail: 'user setting source only (task session)',
    };
    const plan = planClaude(userSpec, null, run);
    expect(plan.args[plan.args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(plan.args).not.toContain('--append-system-prompt-file');
    // Слой человека CLI читает сам (`user` из CLAUDE_CONFIG_DIR); слой репозитория в наш
    // `--settings` не переносится.
    const settings = settingsOf(plan);
    expect(settings.env?.REPO_VAR).toBeUndefined();
    expect(JSON.stringify(settings.hooks)).not.toContain('repo.sh');

    // Тот же сеанс с брифом и без `sources` — флаг брифа есть, источники CLI как есть.
    const normal = planClaude(spec(cwd, config), null, trustedLayer(spec(cwd, config)));
    expect(normal.args).toContain('--append-system-prompt-file');
    expect(normal.args).not.toContain('--setting-sources');
  });

  it('F-86: trusted `on` leaves the CLI its own sources; trusted observe still reads the repo files', () => {
    const { cwd, config } = stand();
    const on = planClaude(spec(cwd, config), null, trustedLayer(spec(cwd, config)));
    expect(on.args).not.toContain('--setting-sources');

    const observeSpec = spec(cwd, config, { layer: { hooks: 'observe', skills: 'on' } });
    const observe = settingsOf(planClaude(observeSpec, null, trustedLayer(observeSpec)));
    expect(observe.env).toEqual({ HUMAN_VAR: 'h', REPO_VAR: 'r', LOCAL: 'l' });
    expect(observe.permissions.deny).toContain('Bash(rm:*)');
  });

  it('F-86: a broken repo file refuses an untrusted copy (its deny would be lost); a broken human file still refuses', () => {
    const { cwd, config } = stand();
    expect(refuseClaude(spec(cwd, config), {}, UNTRUSTED)).toBeNull();
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{broken');
    expect(refuseClaude(spec(cwd, config), {}, UNTRUSTED)).toMatch(
      /^repo settings unreadable, their deny rules would be lost: .*settings\.json: not JSON/,
    );
    const observeSpec = spec(cwd, config, { layer: { hooks: 'observe', skills: 'on' } });
    expect(refuseClaude(observeSpec, {}, trustedLayer(observeSpec))).toContain('unreadable');

    writeFileSync(join(config, 'settings.json'), 'nope');
    expect(refuseClaude(spec(cwd, config), {}, UNTRUSTED)).toContain(join(config, 'settings.json'));
  });

  it('F-86: untrusted copy reads the SOURCE repo deny too (settings.local.json lives only there); a broken source file refuses', () => {
    const { cwd, config } = stand();
    const source = join(cwd, '..', 'source');
    mkdirSync(join(source, '.claude'), { recursive: true });
    writeFileSync(
      join(source, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['Bash(curl:*)'] }, env: { SRC: 's' } }),
    );
    const untrusted = spec(cwd, config, { trust: { sourceRepo: source, panelMark: false } });
    const plan = planClaude(untrusted, null, UNTRUSTED);
    const settings = settingsOf(plan);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(rm:*)', 'Bash(curl:*)']),
    );
    expect(settings.env).toEqual({ HUMAN_VAR: 'h' });
    expect(plan.layerDetail).toMatch(/^2 repo deny rules carried from /);
    // Доверенный слой файлы репозитория отдаёт CLI самому: ядро их запреты не дублирует.
    expect(planClaude(untrusted, null, trustedLayer(untrusted)).layerDetail).toBeUndefined();

    writeFileSync(join(source, '.claude', 'settings.local.json'), '{"permissions":{"deny":1}}');
    expect(refuseClaude(untrusted, {}, UNTRUSTED)).toContain(
      `${join(source, '.claude', 'settings.local.json')}: permissions.deny is not an array`,
    );
    expect(refuseClaude(untrusted, {}, trustedLayer(untrusted))).toBeNull();
  });

  it("F-86: repo /path rules are anchored at each repo root (CLI reads /x from the settings file's dir); core tool rules dropped", () => {
    const { cwd, config } = stand();
    const source = join(cwd, '..', 'source');
    mkdirSync(join(source, '.claude'), { recursive: true });
    writeFileSync(
      join(source, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          deny: [
            'Read(/secret.txt)',
            'Edit(/)',
            'Read(//abs/x)',
            'Read(./rel)',
            'mcp__agentdeck-permit__approve',
            'mcp__step__*',
            'mcp__repo__tool',
          ],
        },
      }),
    );
    const untrusted = spec(cwd, config, {
      trust: { sourceRepo: source, panelMark: false },
      mcpServers: { step: { command: 'x', args: [] } },
      permitServer: { name: 'agentdeck-permit', tool: 'approve' },
    });
    const plan = planClaude(untrusted, null, UNTRUSTED);
    const deny = settingsOf(plan).permissions.deny;
    const posix = (p: string) =>
      p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    expect(deny).toContain(`Read(/${posix(join(cwd, '..', 'source'))}/secret.txt)`);
    expect(deny).toContain(`Read(/${posix(cwd)}/secret.txt)`);
    expect(deny).toContain(`Edit(/${posix(cwd)})`);
    expect(deny).not.toContain('Read(/secret.txt)');
    expect(deny).not.toContain('Edit(/)');
    expect(deny).toEqual(
      expect.arrayContaining(['Read(//abs/x)', 'Read(./rel)', 'mcp__repo__tool']),
    );
    expect(deny).not.toContain('mcp__agentdeck-permit__approve');
    expect(deny).not.toContain('mcp__step__*');
    expect(plan.layerDetail).toMatch(
      /dropped \(would deny core tools\): mcp__agentdeck-permit__approve, mcp__step__\*$/,
    );
  });

  it('F-86: trusted observe anchors the project /path rule at cwd and the human /path rule at the config dir', () => {
    const { cwd, config } = stand();
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['Read(/secret.txt)'] } }),
    );
    writeFileSync(
      join(config, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Read(/human.txt)'] } }),
    );
    const observeSpec = spec(cwd, config, { layer: { hooks: 'observe', skills: 'on' } });
    const deny = settingsOf(planClaude(observeSpec, null, trustedLayer(observeSpec))).permissions
      .deny;
    const posix = (p: string) =>
      p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    expect(deny).toContain(`Read(/${posix(cwd)}/secret.txt)`);
    expect(deny).not.toContain('Read(/secret.txt)');
    expect(deny).toContain(`Read(/${posix(config)}/human.txt)`);
    expect(deny).not.toContain('Read(/human.txt)');
  });
});
