import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPS, CLAUDE_LAYER } from '../claude/claude.ts';
import { layerHooks, readUserLayer, userLayerFiles } from '../claude/user-layer.ts';
import { parseFrontmatter, skillFlowOf } from '../layer-inventory.ts';
import { QWEN_CAPS, QWEN_LAYER } from '../qwen/qwen.ts';

/**
 * Опись слоя человека (этап 7, 01:18-20, 06:114-129): что лежит в слое, с хешем, где непрочитанное
 * названо и входит в хеш (F25). Frontmatter навыков терпит BOM и CRLF — файлы человека пишут и в
 * Windows-редакторах. Ключи хуков описи — те же, что у записи `observe`.
 */

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

function claudeStand() {
  const root = mkdtempSync(join(tmpdir(), 'layer-inv-'));
  const cfg = join(root, 'cfg');
  const cwd = join(root, 'repo');
  const pin = { CLAUDE_CONFIG_DIR: cfg, HOME: join(root, 'home'), USERPROFILE: join(root, 'home') };
  put(
    join(cfg, 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'u' }] }] },
    }),
  );
  put(join(cfg, 'CLAUDE.md'), 'user instructions\n');
  put(join(cfg, 'rules', 'a.md'), 'rule\n');
  put(
    join(cfg, 'skills', 'flow', 'SKILL.md'),
    '﻿---\r\nname: flow-skill\r\nagentdeck:\r\n  steps:\r\n    - id: one\r\n      title: First\r\n    - id: two\r\n      title: Second\r\n  extra: 1\r\n---\r\nbody\r\n',
  );
  put(join(cfg, 'agents', 'rev.md'), '---\nname: reviewer\nmodel: haiku\n---\nprompt\n');
  put(join(cfg, 'agents', 'inh.md'), '---\nname: inheritor\nmodel: inherit\n---\nprompt\n');
  put(join(cfg, 'commands', 'go.md'), 'command\n');
  // Каталог на месте SKILL.md — файл не читается: назван в unread, а не пропущен.
  mkdirSync(join(cfg, 'skills', 'broken', 'SKILL.md'), { recursive: true });
  put(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'p' }] }] } }),
  );
  put(join(cwd, 'CLAUDE.md'), 'project instructions\n');
  put(join(cwd, '.claude', 'skills', 'proj', 'SKILL.md'), '---\nname: proj\n---\n');
  return { root, cfg, cwd, pin };
}

describe('user layer inventory (stage 7)', () => {
  it('claude: every part is listed, unreadable named in the hash, project parts only for a trusted copy', () => {
    const s = claudeStand();
    const inv = CLAUDE_LAYER.inventory(s.pin, s.cwd, true);
    expect(inv.cli).toBe('claude');
    expect(inv.hash).toMatch(/^[0-9a-f]{64}$/);
    const kinds = inv.sources.map(
      (src) =>
        `${src.scope}:${src.kind}:${src.path.slice(s.root.length + 1).replaceAll('\\', '/')}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'user:settings:cfg/settings.json',
        'project:settings:repo/.claude/settings.json',
        'user:instructions:cfg/CLAUDE.md',
        'user:rules:cfg/rules/a.md',
        'project:instructions:repo/CLAUDE.md',
        'user:skill:cfg/skills/flow/SKILL.md',
        'project:skill:repo/.claude/skills/proj/SKILL.md',
        'user:skill:cfg/commands/go.md',
        'user:agent:cfg/agents/rev.md',
      ]),
    );
    expect(inv.unread.map((u) => u.path)).toEqual([join(s.cfg, 'skills', 'broken', 'SKILL.md')]);
    expect(inv.skills.find((k) => k.name === 'flow-skill')).toMatchObject({
      flow: {
        steps: [
          { id: 'one', title: 'First' },
          { id: 'two', title: 'Second' },
        ],
      },
      extraKeys: ['agentdeck.extra'],
    });
    expect(inv.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'reviewer', model: 'haiku' }),
        expect.objectContaining({ name: 'inheritor', model: null }),
      ]),
    );
    expect(inv.hooks.map((h) => [h.key, h.matcher, h.command])).toEqual([
      ['PreToolUse.0.0', 'Bash', 'u'],
      ['Stop.0.0', null, 'p'],
    ]);

    const untrusted = CLAUDE_LAYER.inventory(s.pin, s.cwd, false);
    expect(untrusted.sources.some((src) => src.scope !== 'user')).toBe(false);
    expect(untrusted.hooks.map((h) => h.key)).toEqual(['PreToolUse.0.0']);
    expect(untrusted.hash).not.toBe(inv.hash);
  });

  it('claude: the hash is stable and moves on any edit, including an unreadable file becoming readable', () => {
    const s = claudeStand();
    const first = CLAUDE_LAYER.inventory(s.pin, s.cwd, true).hash;
    expect(CLAUDE_LAYER.inventory(s.pin, s.cwd, true).hash).toBe(first);
    put(join(s.cfg, 'rules', 'a.md'), 'rule edited\n');
    const edited = CLAUDE_LAYER.inventory(s.pin, s.cwd, true).hash;
    expect(edited).not.toBe(first);
    put(join(s.cfg, 'agents', 'new.md'), '---\nname: new\n---\n');
    expect(CLAUDE_LAYER.inventory(s.pin, s.cwd, true).hash).not.toBe(edited);
  });

  it('claude: inventory hook keys are the recorder keys of observe', () => {
    const s = claudeStand();
    const inv = CLAUDE_LAYER.inventory(s.pin, s.cwd, true);
    const layer = readUserLayer(userLayerFiles(s.pin, s.cwd, true));
    const observed = layerHooks(layer, 'observe', { command: 'rec', log: 'l' }, 'o').observed;
    expect(observed.map((h) => [h.key, h.command, h.sourcePath])).toEqual(
      inv.hooks.map((h) => [h.key, h.command, h.sourcePath]),
    );
  });

  it('qwen: home and copy parts listed with hooks keyed in file order', () => {
    const root = mkdtempSync(join(tmpdir(), 'layer-inv-q-'));
    const home = join(root, 'qhome');
    const cwd = join(root, 'repo');
    put(
      join(home, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'run_shell_command', hooks: [{ command: 'u' }] }] },
      }),
    );
    put(join(home, 'QWEN.md'), 'q\n');
    put(join(home, 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n');
    put(
      join(cwd, '.qwen', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'p' }] }] } }),
    );
    put(join(cwd, '.qwen', 'agents', 'a.md'), '---\nname: a\nmodel: qwen3\n---\n');
    const inv = QWEN_LAYER.inventory({ QWEN_HOME: home }, cwd, false);
    expect(inv.cli).toBe('qwen');
    expect(inv.hooks.map((h) => [h.key, h.matcher, h.command])).toEqual([
      ['PreToolUse.0.0', 'run_shell_command', 'u'],
      ['PreToolUse.1.0', null, 'p'],
    ]);
    expect(inv.skills.map((k) => k.name)).toEqual(['s']);
    expect(inv.agents).toEqual([expect.objectContaining({ name: 'a', model: 'qwen3' })]);
    expect(inv.sources.map((x) => x.kind).sort()).toEqual([
      'agent',
      'instructions',
      'settings',
      'settings',
      'skill',
    ]);
  });

  it('caps from the probe: claude governs skills and keeps hooks in subagents; qwen only the latter', () => {
    expect([CLAUDE_CAPS.skillControl, CLAUDE_CAPS.subagentHooks]).toEqual([true, true]);
    expect([QWEN_CAPS.skillControl, QWEN_CAPS.subagentHooks]).toEqual([false, true]);
  });
});

describe('frontmatter (BOM, CRLF, list of maps)', () => {
  it('reads what skills and agents write, names a flow off the schema', () => {
    expect(parseFrontmatter('no frontmatter')).toBeNull();
    const fm = parseFrontmatter(
      '﻿---\r\nname: "quoted: name"\r\nhooks:\r\n  Stop: []\r\n---\r\nbody',
    );
    expect(fm?.data).toEqual({ name: 'quoted: name', hooks: { Stop: '[]' } });
    expect(fm?.body).toBe('body');
    const bad = parseFrontmatter('---\nagentdeck:\n  steps:\n    - id: x\n---\n');
    expect(skillFlowOf(bad)).toEqual({ flow: null, extraKeys: ['agentdeck.steps'] });
    const sameIndent = parseFrontmatter(
      '---\nagentdeck:\n  steps:\n  - id: a\n    title: A\n---\n',
    );
    expect(skillFlowOf(sameIndent).flow).toEqual({ steps: [{ id: 'a', title: 'A' }] });
  });
});
