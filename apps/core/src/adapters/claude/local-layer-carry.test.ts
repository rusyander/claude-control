import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kitCarryRefusalOf } from '@agentdeck/contracts/core/session-carry';
import { sessionCarryRefusal } from '../../bootstrap/session-road/session-carry-gate.ts';
import type { RoadStart } from '../../bootstrap/session-road/road.types.ts';
import type { LayerRun, SessionLayerCarry, SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planClaude, refuseClaude } from './claude.ts';

/**
 * Локальный слой проекта в плане Claude Code (s10 G14 p6): поле `session.localLayer` → флаги и
 * файлы сеанса. Инструкции — после брифа ядра, плагин — `--plugin-dir`, хуки — в `--settings`
 * ядра рядом с хуком ядра, `allow` — фильтром прав человека, переменные — ниже привязки адреса.
 * Отказ: недоверенная копия, источник `project` рядом со слоем, негодный каталог плагина.
 * Что из этого видит модель настоящего CLI — claude.local-layer.live.integration.test.ts.
 */

const UNTRUSTED: LayerRun = {
  asked: 'on',
  ran: 'observe',
  repoLayer: false,
  trust: 'none',
  detail: 'no mark',
};

function stand(): { cwd: string; config: string; plugin: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-local-layer-'));
  const cwd = join(root, 'work');
  const config = join(root, 'cfg');
  const plugin = join(cwd, '.agent', 'local-layer', 'build', 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'project' }));
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.json'), '{}');
  return { cwd, config, plugin };
}

function spec(cwd: string, config: string, carry?: SessionLayerCarry): SessionSpec {
  return {
    sessionId: '44444444-4444-4444-8444-444444444444',
    dir: join(cwd, '..', 'session'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on', ...(carry ? { carry } : {}) },
    env: { pin: { CLAUDE_CONFIG_DIR: config } },
    coreHook: 'node core.mjs',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
  };
}

const LAYER_HOOK = { hooks: [{ type: 'command', command: 'node layer-hook.mjs' }] };

function carryOf(plugin: string): SessionLayerCarry {
  return {
    settingSources: ['user', 'local'],
    localLayer: {
      plugin,
      instructions: 'LAYER_INSTRUCTIONS',
      hooks: { SessionStart: [LAYER_HOOK], PreToolUse: [{ matcher: 'Bash', ...LAYER_HOOK }] },
      permissions: {
        allow: ['Bash(npm test:*)', 'Bash(*)', 'Read'],
        ask: ['Bash(git push:*)'],
        deny: ['Bash(rm -rf:*)'],
      },
      env: { TEAM_ENV: 'team', ANTHROPIC_BASE_URL: 'https://team.example.com' },
    },
  };
}

const settingsOf = (plan: ReturnType<typeof planClaude>) =>
  JSON.parse(plan.files['claude/settings.json']!) as {
    env?: Record<string, string>;
    permissions: { allow?: string[]; ask?: string[]; deny: string[] };
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };

describe('claude adapter — the project local layer carry', () => {
  it('on: instructions after the brief, the plugin flag, layer hooks beside the core hook, narrowed sources', () => {
    const { cwd, config, plugin } = stand();
    const s = spec(cwd, config, carryOf(plugin));
    const plan = planClaude(s, null, trustedLayer(s));
    expect(plan.files['claude/brief.md']).toBe('BRIEF\n\nLAYER_INSTRUCTIONS');
    expect(plan.args[plan.args.indexOf('--setting-sources') + 1]).toBe('user,local');
    expect(plan.args[plan.args.lastIndexOf('--plugin-dir') + 1]).toBe(plugin);
    const settings = settingsOf(plan);
    expect(settings.hooks.SessionStart).toEqual([LAYER_HOOK]);
    const pre = JSON.stringify(settings.hooks.PreToolUse);
    expect(pre).toContain('layer-hook.mjs');
    expect(pre).toContain('core.mjs');
  });

  it('permissions: an open shell allow is dropped like a human one; ask and deny are carried', () => {
    const { cwd, config, plugin } = stand();
    const s = spec(cwd, config, carryOf(plugin));
    const { permissions } = settingsOf(planClaude(s, null, trustedLayer(s)));
    expect(permissions.allow).toEqual(['Bash(npm test:*)', 'Read']);
    expect(permissions.ask).toEqual(['Bash(git push:*)']);
    expect(permissions.deny).toContain('Bash(rm -rf:*)');
  });

  it('env: layer values ride under the endpoint binding — the step address wins', () => {
    const { cwd, config, plugin } = stand();
    const s = spec(cwd, config, carryOf(plugin));
    const binding = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } };
    const { env } = settingsOf(planClaude(s, binding as never, trustedLayer(s)));
    expect(env?.TEAM_ENV).toBe('team');
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9');
  });

  it('no carry: no layer parts at all — the brief alone, no plugin, no layer hooks', () => {
    const { cwd, config } = stand();
    const s = spec(cwd, config);
    const plan = planClaude(s, null, trustedLayer(s));
    expect(plan.files['claude/brief.md']).toBe('BRIEF');
    expect(plan.args).not.toContain('--plugin-dir');
    expect(JSON.stringify(settingsOf(plan).hooks)).not.toContain('layer-hook.mjs');
  });

  it('refusals: untrusted copy, the project source beside the layer, sources not narrowed, a plugin with MCP servers', () => {
    const { cwd, config, plugin } = stand();
    const good = spec(cwd, config, carryOf(plugin));
    expect(refuseClaude(good, {}, trustedLayer(good))).toBeNull();
    expect(refuseClaude(good, {}, UNTRUSTED)).toMatch(
      /^session-carry-local-layer-needs-layer-on: .*'observe' \(folder not trusted\)$/,
    );
    const withProject = spec(cwd, config, {
      ...carryOf(plugin),
      settingSources: ['project', 'local'],
    });
    expect(refuseClaude(withProject, {}, trustedLayer(withProject))).toMatch(
      /^session-carry-local-layer-with-project:/,
    );
    const { settingSources: _all, ...wide } = carryOf(plugin);
    const unnarrowed = spec(cwd, config, wide);
    expect(refuseClaude(unnarrowed, {}, trustedLayer(unnarrowed))).toMatch(
      /^session-carry-local-layer-with-project:/,
    );
    writeFileSync(join(plugin, '.mcp.json'), '{}');
    expect(refuseClaude(good, {}, trustedLayer(good))).toMatch(
      /^session-carry-local-layer-plugin: plugin declares MCP servers/,
    );
  });

  // s10 G14 p7: каждую строку отказа слоя панель узнаёт разбором из контрактов и называет человеку
  // по-русски/по-английски с выходом; строка ядра, которую разбор не узнал, ушла бы в чат сырой.
  it('s10 G14 p7: every local-layer refusal the core writes is recognised by the panel parser', () => {
    const { cwd, config, plugin } = stand();
    const good = spec(cwd, config, carryOf(plugin));
    const narrowed: LayerRun = { ...UNTRUSTED, asked: 'off', ran: 'off' };
    const withProject = spec(cwd, config, { ...carryOf(plugin), settingSources: ['project'] });
    const kindOf = (reason: string | null) => kitCarryRefusalOf(reason ?? '');
    expect(kindOf(refuseClaude(good, {}, UNTRUSTED))).toEqual({ kind: 'layerUntrusted' });
    expect(kindOf(refuseClaude(good, {}, narrowed))).toEqual({ kind: 'layerMode', mode: 'off' });
    expect(kindOf(refuseClaude(withProject, {}, trustedLayer(withProject)))).toEqual({
      kind: 'layerSources',
    });
    writeFileSync(join(plugin, '.mcp.json'), '{}');
    expect(kindOf(refuseClaude(good, {}, trustedLayer(good)))).toEqual({
      kind: 'layerBuild',
      path: plugin,
    });
    const gone = spec(cwd, config, carryOf(join(cwd, 'no-such-plugin')));
    expect(kindOf(refuseClaude(gone, {}, trustedLayer(gone)))).toEqual({
      kind: 'layerBuild',
      path: join(cwd, 'no-such-plugin'),
    });
    const road = sessionCarryRefusal(
      { adapterId: 'qwen', layer: { carry: carryOf(plugin), hooks: 'on' } as RoadStart['layer'] },
      { sessionCarry: { systemPrompt: true } },
    );
    expect(kindOf(road)).toEqual({
      kind: 'unsupported',
      adapter: 'qwen',
      fields: 'settingSources, localLayer',
    });
  });
});
