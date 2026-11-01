import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeLayerParts, EMPTY_PARTS } from './layer-parts.ts';
import { claudeLayerSupply, LAYER_PLUGIN } from './layer-supply.ts';

/**
 * Подача слоя человека без хуков (P87, G-b, проба Q4) по настоящим файлам во временном доме:
 * какие части доходят какой дорогой, старшинство имён, навыки с хуками и `@import` — потери.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stand() {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-supply-'));
  dirs.push(root);
  const cfg = join(root, 'cfg');
  const cwd = join(root, 'work');
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  put(join(cfg, 'CLAUDE.md'), 'USER_MD\n@other.md\n');
  put(join(cfg, 'rules', 'r.md'), '---\npaths: ["src/**"]\n---\nUSER_RULE\n');
  put(join(cfg, 'skills', 'same', 'SKILL.md'), '---\nname: same\n---\nuser skill');
  put(join(cfg, 'skills', 'hooked', 'SKILL.md'), '---\nname: hooked\nhooks:\n  Stop: []\n---\nx');
  put(join(cfg, 'commands', 'cmd.md'), 'user cmd');
  put(join(cfg, 'agents', 'helper.md'), '---\nname: helper\nmodel: haiku\n---\nuser agent');
  put(join(cwd, 'CLAUDE.md'), 'PROJECT_MD');
  put(join(cwd, '.claude', 'skills', 'same', 'SKILL.md'), '---\nname: same\n---\nproject skill');
  put(join(cwd, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nproject agent');
  return { root, cfg, cwd, pin: { CLAUDE_CONFIG_DIR: cfg, HOME: root, USERPROFILE: root } };
}

describe('claudeLayerSupply', () => {
  it('on: nothing re-supplied, skills off still adds the CLI flag', () => {
    expect(claudeLayerSupply(EMPTY_PARTS, 'on', 'on', 'C:/w', 'C:/p')).toMatchObject({
      args: [],
      copies: [],
      detail: [],
    });
    expect(claudeLayerSupply(EMPTY_PARTS, 'on', 'off', 'C:/w', 'C:/p').args).toEqual([
      '--disable-slash-commands',
    ]);
  });

  it('observe: project md by add-dir, user md concatenated, plugin copies by precedence, losses named', () => {
    const s = stand();
    const plugin = join(s.root, 'session', 'claude', 'plugin');
    const supply = claudeLayerSupply(
      claudeLayerParts(s.pin, s.cwd, true),
      'observe',
      'on',
      s.cwd,
      plugin,
    );
    expect(supply.args).toEqual(['--add-dir', s.cwd]);
    expect(supply.env).toEqual({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' });
    expect(supply.briefTail).toContain('USER_MD');
    expect(supply.briefTail).toContain('USER_RULE');
    expect(supply.briefTail).not.toContain('PROJECT_MD');
    const copies = supply.copies.map((c) => [
      c.from.slice(s.root.length + 1),
      c.to.slice(plugin.length + 1),
    ]);
    // Навык человека старше навыка репозитория, агент репозитория старше агента человека.
    expect(copies).toEqual([
      [join('cfg', 'skills', 'same'), join('skills', 'same')],
      [join('cfg', 'commands', 'cmd.md'), join('commands', 'cmd.md')],
      [join('work', '.claude', 'agents', 'helper.md'), join('agents', 'helper.md')],
    ]);
    expect(Object.keys(supply.files)).toEqual([join(plugin, '.claude-plugin', 'plugin.json')]);
    expect(JSON.parse(Object.values(supply.files)[0]!)).toMatchObject({ name: LAYER_PLUGIN });
    expect(supply.detail).toEqual([
      `observe: path-scoped rule ${join(s.cfg, 'rules', 'r.md')} loads unconditionally`,
      `observe: skills, commands and agents re-supplied as ${LAYER_PLUGIN}:<name>`,
    ]);
    expect(supply.losses).toEqual([
      `@imports in ${join(s.cfg, 'CLAUDE.md')} are not resolved`,
      'skill hooked carries its own hooks, not re-supplied',
    ]);
  });

  it('skills off: flag, no skill or command copies, agents still copied', () => {
    const s = stand();
    const supply = claudeLayerSupply(
      claudeLayerParts(s.pin, s.cwd, true),
      'off',
      'off',
      s.cwd,
      'P',
    );
    expect(supply.args[0]).toBe('--disable-slash-commands');
    expect(supply.copies.map((c) => c.to)).toEqual([join('P', 'agents', 'helper.md')]);
  });

  it('untrusted copy: no project parts, no add-dir', () => {
    const s = stand();
    const supply = claudeLayerSupply(
      claudeLayerParts(s.pin, s.cwd, false),
      'off',
      'on',
      s.cwd,
      'P',
    );
    expect(supply.args).toEqual([]);
    expect(supply.copies.every((c) => c.from.startsWith(s.cfg))).toBe(true);
  });
});
