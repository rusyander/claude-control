import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import {
  coreServers,
  deniesCoreTool,
  readRepoDeny,
  repoDenyDetail,
  repoDenyRefusal,
  repoDenyRoots,
  repoDenySources,
  stripJsonComments,
} from './repo-deny.ts';

/**
 * Запреты репозитория в недоверенной копии (F-86): чтение данными, отказ на неразобранном файле,
 * снятие правил, которые закрыли бы инструменты ядра, JSONC как у Qwen.
 */

const DENY = [['permissions', 'deny']] as const;
const BOTH = [
  ['permissions', 'deny'],
  ['tools', 'exclude'],
] as const;

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-deny-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, '.cli'), { recursive: true });
    writeFileSync(join(root, '.cli', name), text);
  }
  return root;
}

const read = (root: string, fields = DENY as typeof DENY | typeof BOTH, jsonc = false) =>
  readRepoDeny(
    repoDenySources([root], '.cli', ['a.json', 'b.json'], fields, jsonc),
    new Set(['agentdeck-permit', 'step-mcp']),
  );

describe('repo deny — read as data (F-86)', () => {
  it('reads permissions.deny of every present file, keeps strings only, no repeats; absent files are nothing', () => {
    const root = repo({
      'a.json': JSON.stringify({
        permissions: { deny: ['Bash(rm:*)', 7, null, '  ', 'Read(/x)'], allow: ['Bash'] },
        hooks: { PreToolUse: [] },
        env: { X: '1' },
      }),
      'b.json': JSON.stringify({ permissions: { deny: ['Read(/x)', 'WebFetch'] } }),
    });
    const deny = read(root);
    expect(deny.rules).toEqual(['Bash(rm:*)', 'Read(/x)', 'WebFetch']);
    expect(deny.read).toEqual([join(root, '.cli', 'a.json'), join(root, '.cli', 'b.json')]);
    expect(deny.unreadable).toEqual([]);
    expect(read(repo({})).read).toEqual([]);
  });

  it('a file with no permissions or no deny is read and empty', () => {
    const deny = read(repo({ 'a.json': '{}', 'b.json': '{"permissions":{}}' }));
    expect(deny.rules).toEqual([]);
    expect(deny.read).toHaveLength(2);
  });

  it.each([
    ['{broken', /not JSON/],
    ['[]', /not an object/],
    ['null', /not an object/],
    ['"x"', /not an object/],
    ['{"permissions":[]}', /permissions is not an object/],
    ['{"permissions":"x"}', /permissions is not an object/],
    ['{"permissions":{"deny":"Bash"}}', /permissions\.deny is not an array/],
    ['{"permissions":{"deny":{"0":"Bash"}}}', /permissions\.deny is not an array/],
  ])('unreadable %s → named, the launch refuses', (text, why) => {
    const root = repo({ 'a.json': text });
    const deny = read(root);
    expect(deny.unreadable).toHaveLength(1);
    expect(deny.unreadable[0]).toMatch(why);
    expect(deny.unreadable[0]!.startsWith(join(root, '.cli', 'a.json'))).toBe(true);
    expect(repoDenyRefusal(deny)).toBe(
      `repo settings unreadable, their deny rules would be lost: ${deny.unreadable[0]}`,
    );
  });

  it('a directory in place of the file is unreadable, not absent', () => {
    const root = repo({});
    mkdirSync(join(root, '.cli', 'a.json'), { recursive: true });
    expect(read(root).unreadable).toHaveLength(1);
  });

  it('a leading byte-order mark is not part of the JSON', () => {
    const deny = read(
      repo({
        'a.json': String.fromCharCode(0xfeff) + JSON.stringify({ permissions: { deny: ['Bash'] } }),
      }),
    );
    expect(deny.rules).toEqual(['Bash']);
  });

  it('second list (Qwen tools.exclude) joins the deny; its wrong shape is unreadable', () => {
    const ok = read(
      repo({ 'a.json': '{"permissions":{"deny":["a"]},"tools":{"exclude":["b","a"]}}' }),
      BOTH,
    );
    expect(ok.rules).toEqual(['a', 'b']);
    const bad = read(repo({ 'a.json': '{"tools":{"exclude":"b"}}' }), BOTH);
    expect(bad.unreadable[0]).toMatch(/tools\.exclude is not an array/);
  });

  it('JSONC: comments stripped only when the CLI reads JSONC', () => {
    const text = '{ // c\n "permissions": { /* d */ "deny": ["a"] } }';
    expect(read(repo({ 'a.json': text }), DENY, true).rules).toEqual(['a']);
    expect(read(repo({ 'a.json': text }), DENY, false).unreadable[0]).toMatch(/not JSON/);
  });
});

describe('repo deny — rules that would deny core tools are dropped (F-86)', () => {
  const core = new Set(['agentdeck-permit', 'step-mcp']);
  it.each([
    ['mcp__agentdeck-permit__approve', true],
    ['mcp__agentdeck-permit', true],
    ['mcp__step-mcp__*', true],
    ['mcp__step-mcp__run(x)', true],
    ['mcp__*', true],
    ['mcp__agent*', true],
    ['*', true],
    ['Bas?', true],
    ['mcp__repo-own__tool', false],
    ['mcp__agentdeck-permit-x__tool', false],
    ['Bash(rm *)', false],
    ['Read(/x/**)', false],
    ['run_shell_command(mkdir:*)', false],
  ])('%s → dropped %s', (rule, dropped) => {
    expect(deniesCoreTool(rule, core)).toBe(dropped);
  });

  it('dropped rules are named once in the detail; carried count excludes them', () => {
    const root = repo({
      'a.json': JSON.stringify({
        permissions: { deny: ['mcp__step-mcp__run', 'Bash(rm:*)', 'mcp__step-mcp__run', '*'] },
      }),
    });
    const deny = read(root);
    expect(deny.rules).toEqual(['Bash(rm:*)']);
    expect(deny.dropped).toEqual(['mcp__step-mcp__run', '*']);
    expect(repoDenyDetail(deny)).toBe(
      `1 repo deny rules carried from ${join(root, '.cli', 'a.json')}; dropped (would deny core tools): mcp__step-mcp__run, *`,
    );
  });

  it('no file read → no detail; nothing unreadable → no refusal', () => {
    const deny = read(repo({}));
    expect(repoDenyDetail(deny)).toBeUndefined();
    expect(repoDenyRefusal(deny)).toBeNull();
  });

  it('core servers: step servers and the permit server', () => {
    const spec = {
      mcpServers: { 'step-mcp': { command: 'x', args: [] } },
      permitServer: { name: 'agentdeck-permit', tool: 'approve' },
    } as unknown as SessionSpec;
    expect([...coreServers(spec)].sort()).toEqual(['agentdeck-permit', 'step-mcp']);
    expect([...coreServers({ mcpServers: {} } as unknown as SessionSpec)]).toEqual([]);
  });
});

describe('repo deny — roots and JSONC', () => {
  it('roots: source repo then the copy, the same path once; no source → the copy alone', () => {
    const base = mkdtempSync(join(tmpdir(), 'repo-deny-roots-'));
    const src = join(base, 'src');
    const cwd = join(base, 'copy');
    const spec = (trust?: SessionSpec['trust']) =>
      ({ cwd, ...(trust ? { trust } : {}) }) as unknown as SessionSpec;
    expect(repoDenyRoots(spec({ sourceRepo: src, panelMark: false }))).toEqual([src, cwd]);
    expect(repoDenyRoots(spec({ sourceRepo: join(cwd, '.'), panelMark: false }))).toEqual([cwd]);
    expect(repoDenyRoots(spec())).toEqual([cwd]);
  });

  it('strip keeps strings (slashes, escaped quotes) and line breaks; replaces comments with spaces', () => {
    const text = '{"a":"x//y","b":"q\\"//z", /* m\nn */ "c":1} // t';
    const out = stripJsonComments(text);
    expect(out).toHaveLength(text.length);
    expect(JSON.parse(out)).toEqual({ a: 'x//y', b: 'q"//z', c: 1 });
    expect(out.split('\n')).toHaveLength(2);
    expect(stripJsonComments('{} /* open')).toBe('{}'.padEnd(10));
    expect(stripJsonComments('{"a":"\\\\"}//x')).toBe('{"a":"\\\\"}   ');
  });
});
