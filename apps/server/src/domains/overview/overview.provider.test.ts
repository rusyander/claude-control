import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { detectClaudeLocation } from '../../lib/claude-paths/claude-paths.ts';
import { buildOverview } from './overview.ts';

/**
 * Обзор под активным Qwen Code считается по файлам Qwen (`QWEN_HOME`), а не по
 * `~/.claude`. Claude-каталог в кейсе существует и НАПОЛНЕН — иначе «нули» не
 * отличили бы чтение Qwen от чтения пустого Claude.
 */
describe('buildOverview по активному провайдеру', () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-overview-'));
    for (const key of ['QWEN_HOME', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
    const qwen = join(root, 'qwen');
    mkdirSync(join(qwen, 'skills', 'review'), { recursive: true });
    writeFileSync(
      join(qwen, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review code\n---\nBody\n',
    );
    writeFileSync(
      join(qwen, 'settings.json'),
      JSON.stringify({
        mcpServers: { one: { command: 'node', args: ['a.js'] }, two: { httpUrl: 'http://x' } },
        permissions: { allow: ['Bash(git *)', 'Read'], ask: ['Edit'], deny: ['Bash(rm *)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node h.js' }] }],
        },
      }),
    );
    mkdirSync(join(qwen, 'rules', 'frontend'), { recursive: true });
    writeFileSync(join(qwen, 'rules', 'always.md'), 'Always.\n');
    writeFileSync(
      join(qwen, 'rules', 'frontend', 'react.md'),
      '---\npaths:\n  - "src/**/*.tsx"\n---\nReact.\n',
    );
    process.env.QWEN_HOME = qwen;

    const claude = join(root, 'claude');
    mkdirSync(join(claude, 'skills', 'a'), { recursive: true });
    mkdirSync(join(claude, 'skills', 'b'), { recursive: true });
    writeFileSync(join(claude, 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: A\n---\n');
    writeFileSync(join(claude, 'skills', 'b', 'SKILL.md'), '---\nname: b\ndescription: B\n---\n');
    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read', 'Write', 'Glob', 'Grep'] } }),
    );
    process.env.CLAUDE_CONFIG_DIR = claude;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const storeWith = (provider: string): AppStore => {
    const store = new AppStore(mkdtempSync(join(root, 'store-')));
    store.updateSettings({ provider });
    return store;
  };

  it('Qwen: счётчики из settings.json и skills/ Qwen, подпись — Qwen Code', () => {
    const overview = buildOverview(detectClaudeLocation().paths, storeWith('qwen'));
    expect(overview.provider).toEqual({ id: 'qwen', name: 'Qwen Code' });
    expect(overview.skills).toEqual({ total: 1, enabled: 1 });
    expect(overview.mcp?.total).toBe(2);
    expect(overview.permissions).toEqual({ allow: 2, ask: 1, deny: 1 });
    expect(overview.hooks?.total).toBe(1);
    // Правила (MAP 24) — каталог `rules/`, рекурсивно: оба файла.
    expect(overview.rules?.total).toBe(2);
  });

  it('Claude (identity): прежние читатели, подпись — Claude Code', () => {
    const overview = buildOverview(detectClaudeLocation().paths, storeWith('claude'));
    expect(overview.provider.id).toBe('claude');
    expect(overview.skills?.total).toBe(2);
    expect(overview.permissions?.allow).toBe(4);
  });
});
