import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { LayerRun, SessionSpec } from '../adapter.types.ts';
import { claudeHookReader } from './hook-refusal.ts';
import { claudeInventory } from './layer-parts.ts';
import { claudeSessionHooks } from './session-hooks.ts';

/**
 * Хуки, которые Claude Code исполняет в сеансе (R2, 06:121-122), — по временному дому CLI, разложенному
 * как настоящий: `settings.json` человека, реестр `plugins/installed_plugins.json` v2 с каталогом
 * установки, плагин набора с `.claude-plugin/plugin.json` и `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}`).
 */

const hookFile = (matcher: string, command: string) => ({
  hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }] }] },
});

function plugin(root: string, name: string, matcher: string, command: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify(hookFile(matcher, command)));
  return dir;
}

function home() {
  const root = tempDir('cl-home-');
  const config = join(root, '.claude');
  const cwd = join(root, 'work');
  mkdirSync(join(config, 'plugins'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const installed = plugin(join(config, 'plugins', 'cache'), 'lint-kit', 'Write', 'node lint.mjs');
  writeFileSync(
    join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'lint-kit@market': [{ scope: 'user', installPath: installed }] },
    }),
  );
  writeFileSync(
    join(config, 'settings.json'),
    JSON.stringify({
      ...hookFile('Bash', 'node user-guard.mjs'),
      enabledPlugins: { 'lint-kit@market': true },
    }),
  );
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify(hookFile('Read', 'node p.mjs')),
  );
  const kit = plugin(
    tempDir('cl-kit-'),
    'agentdeck-kit',
    'Agent|Task',
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/lib/run.mjs" pre',
  );
  const pin = { CLAUDE_CONFIG_DIR: config, HOME: root, USERPROFILE: root };
  return { pin, cwd, kit, installed };
}

const keys = (hooks: readonly { key: string }[]) => hooks.map((h) => h.key);

describe('claude session hooks: every hook the CLI runs for the session (R2)', () => {
  it('on: settings of loaded sources + plugins the settings enable + the panel kit plugin', () => {
    const h = home();
    const run = claudeSessionHooks(h.pin, h.cwd, true, {
      ran: 'on',
      carry: { plugins: [h.kit] },
    });
    expect(keys(run.hooks)).toEqual([
      'PreToolUse.0.0',
      'PreToolUse.1.0',
      'agentdeck-kit:PreToolUse.0.0',
      'lint-kit:PreToolUse.0.0',
    ]);
    expect(run.sources.map((s) => s.path)).toEqual([
      join(h.kit, 'hooks', 'hooks.json'),
      join(h.installed, 'hooks', 'hooks.json'),
    ]);
  });

  it('on with narrowed sources: the user file and the plugins it enables are not loaded', () => {
    const h = home();
    const run = claudeSessionHooks(h.pin, h.cwd, true, {
      ran: 'on',
      carry: { plugins: [h.kit], settingSources: ['project', 'local'] },
    });
    expect(run.hooks.map((x) => [x.key, x.matcher])).toEqual([
      ['PreToolUse.0.0', 'Read'],
      ['agentdeck-kit:PreToolUse.0.0', 'Agent|Task'],
    ]);
    // Песочница (`sources: 'user'`): только файл человека и его плагины.
    const sandbox = claudeSessionHooks(h.pin, h.cwd, true, { ran: 'on', sources: 'user' });
    expect(keys(sandbox.hooks)).toEqual(['PreToolUse.0.0', 'lint-kit:PreToolUse.0.0']);
  });

  it('observe: setting sources are not loaded (no enabled plugins), the carried kit still runs; no session facts → as before', () => {
    const h = home();
    const observe = claudeSessionHooks(h.pin, h.cwd, true, {
      ran: 'observe',
      carry: { plugins: [h.kit], localLayer: { hooks: hookFile('Edit', 'node ll.mjs').hooks } },
    });
    expect(keys(observe.hooks)).toEqual([
      'PreToolUse.0.0',
      'PreToolUse.1.0',
      'local-layer:PreToolUse.0.0',
      'agentdeck-kit:PreToolUse.0.0',
    ]);
    const before = claudeInventory(h.pin, h.cwd, true);
    expect(keys(before.hooks)).toEqual(['PreToolUse.0.0', 'PreToolUse.1.0']);
    expect(claudeInventory(h.pin, h.cwd, true, { ran: 'on' }).hash).not.toBe(before.hash);
  });

  it('the hook reader names a kit hook by its command, written or with the plugin root expanded', () => {
    const h = home();
    const spec = {
      env: { pin: h.pin },
      cwd: h.cwd,
      layer: { hooks: 'on', skills: 'on', carry: { plugins: [h.kit] } },
    } as unknown as SessionSpec;
    const deniedBy = (command: string) => ({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: `PreToolUse:Agent hook error: [${command}]: no [return-format]`,
          },
        ],
      },
      tool_result_meta: [{ id: 'toolu_1', permission_decision: { source: 'hook' } }],
    });
    const layer = (ran: LayerRun['ran']): LayerRun => ({
      asked: 'on',
      ran,
      repoLayer: true,
      trust: 'panel',
    });
    const written = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/lib/run.mjs" pre';
    const expanded = written.replace('${CLAUDE_PLUGIN_ROOT}', h.kit);
    for (const command of [written, expanded])
      expect(claudeHookReader(spec, layer('on'))(deniedBy(command))).toMatchObject([
        { hook: 'agentdeck-kit:PreToolUse.0.0', reason: 'no [return-format]' },
      ]);
    // Недоверие снизило `on` до `observe`: набор CLI исполняет сам — ключ тот же.
    expect(claudeHookReader(spec, layer('observe'))(deniedBy(expanded))).toMatchObject([
      { hook: 'agentdeck-kit:PreToolUse.0.0' },
    ]);
  });
});
