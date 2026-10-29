import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Пути read/edit судьи (core-s2 F-126, F-12, F-13): токен ядра не читается другим написанием
 * пути (UNC loopback, `\\?\`, `\\.\`, поток NTFS, хвостовая точка), поиск по предку дома ядра —
 * отказ, настройки CLI копии (`<копия>/.claude/**`) не правятся.
 */

const isWin = process.platform === 'win32';
const coreHome = join(homeDir(), '.agentdeck-core-judge-test');
const token = join(coreHome, 'token');
const copyRoot = process.cwd();

const ctx: PermitContext = {
  copyRoot,
  ownedPaths: [],
  deny: { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] },
  platformPaths: [coreHome],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const ask = (action: 'read' | 'edit', target: string): PermissionAsk => ({
  action,
  target,
  tool: action === 'read' ? 'Read' : 'Write',
  display: `${action} ${target}`,
});

describe.runIf(isWin)('F-126 the core token under another Windows spelling', () => {
  const drive = token.slice(0, 1);
  const tail = token.slice(2);
  it.each([
    ['UNC localhost admin share', `\\\\localhost\\${drive}$${tail}`],
    ['UNC 127.0.0.1, lower-case share', `\\\\127.0.0.1\\${drive.toLowerCase()}$${tail}`],
    ['UNC [::1]', `\\\\[::1]\\${drive}$${tail}`],
    ['UNC own host name', `\\\\${hostname()}\\${drive}$${tail}`],
    ['long prefix', `\\\\?\\${token}`],
    ['device prefix', `\\\\.\\${token}`],
    ['long UNC prefix', `\\\\?\\UNC\\localhost\\${drive}$${tail}`],
    ['forward-slash UNC', `//localhost/${drive}$${tail.replace(/\\/g, '/')}`],
    ['NTFS default stream', `${token}::$DATA`],
    ['named stream', `${token}:s`],
    ['trailing dot', `${token}.`],
    ['trailing dot on the directory', `${coreHome}. \\token`],
    ['GLOBALROOT device', `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3${tail}`],
    ['foreign server share', '\\\\fileserver\\share\\x'],
  ])('%s → read refused', (_form, target) => {
    expect(decidePermit(ask('read', target), ctx)).toMatchObject({
      allow: false,
      code: 'platform-path',
    });
  });

  it.each([
    ['.git with a trailing dot', '.git.\\config'],
    ['.git default stream', '.git::$DATA\\config'],
  ])('%s → edit refused as git internals', (_form, target) => {
    expect(decidePermit(ask('edit', target), ctx)).toMatchObject({
      allow: false,
      code: 'git-internals',
    });
  });
});

describe('F-13 read or search over an ancestor of the core home', () => {
  it.each([
    ['home itself', homeDir()],
    ['glob rooted at home', join(homeDir(), '**', 'token')],
    ['glob inside the core home', join(coreHome, '*')],
  ])('%s → refused', (_form, target) => {
    expect(decidePermit(ask('read', target), ctx)).toMatchObject({
      allow: false,
      code: 'platform-path',
    });
  });

  it.each([
    ['a file of the copy', 'src/index.ts'],
    ['a sibling of the core home', join(homeDir(), '.agentdeck-core-judge-other', 'x')],
    ['a glob inside the copy', 'src/**/*.ts'],
  ])('%s → allowed', (_form, target) => {
    // Сосед дома ядра лежит вне копии: с F-87 его открывает только область чтения. Проверка
    // здесь — что запрет платформы не цепляет соседа, поэтому сосед — в списке человека.
    const scoped: PermitContext = {
      ...ctx,
      readScope: {
        roots: [],
        human: [join(homeDir(), '.agentdeck-core-judge-other')],
        credentials: [],
      },
    };
    expect(decidePermit(ask('read', target), scoped)).toMatchObject({ allow: true });
  });

  it('a sibling of the core home outside the read scope → outside-copy, not platform-path', () => {
    const target = join(homeDir(), '.agentdeck-core-judge-other', 'x');
    expect(decidePermit(ask('read', target), ctx)).toMatchObject({
      allow: false,
      code: 'outside-copy',
    });
  });
});

describe('deny.editPaths of the session is honoured by the judge', () => {
  const root = mkdtempSync(join(tmpdir(), 'permit-editpaths-'));
  const qwenDir = join(root, '.qwen');
  mkdirSync(qwenDir);
  writeFileSync(join(qwenDir, 'settings.json'), '{}');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const withDeny: PermitContext = {
    ...ctx,
    copyRoot: root,
    deny: { ...ctx.deny, editPaths: [qwenDir] },
  };

  it.each([
    ['.qwen/settings.json relative', '.qwen/settings.json'],
    ['absolute', join(qwenDir, 'settings.json')],
    ['a new file under it', '.qwen/new.md'],
  ])('%s → refused', (_form, target) => {
    expect(decidePermit(ask('edit', target), withDeny)).toMatchObject({
      allow: false,
      code: 'denied-path',
    });
  });

  it.runIf(isWin)('upper-case and 8.3 short spellings → refused', () => {
    expect(decidePermit(ask('edit', '.QWEN\\settings.json'), withDeny)).toMatchObject({
      code: 'denied-path',
    });
    const short = spawnSync('cmd', [`/d /c for %I in ("${qwenDir}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).stdout.trim();
    // Тома без имён 8.3 бывают: тогда короткое написание совпадает с длинным, проверять нечего.
    if (short.toLowerCase() === qwenDir.toLowerCase()) return;
    expect(short).toMatch(/~\d/);
    expect(decidePermit(ask('edit', join(short, 'settings.json')), withDeny)).toMatchObject({
      code: 'denied-path',
    });
  });

  it('reads stay allowed, other files stay editable', () => {
    expect(decidePermit(ask('read', '.qwen/settings.json'), withDeny)).toMatchObject({
      allow: true,
    });
    expect(decidePermit(ask('edit', '.qwen-notes.md'), withDeny)).toMatchObject({ allow: true });
  });
});

describe('argvExact:false with no shell text', () => {
  it('refused as publish-unknown; with the text it is judged as usual', () => {
    const exec = (display: string): PermissionAsk => ({
      action: 'exec',
      target: 'ls',
      argv: ['ls'],
      argvExact: false,
      tool: 'Bash',
      display,
    });
    expect(decidePermit(exec(''), ctx)).toMatchObject({ allow: false, code: 'publish-unknown' });
    expect(decidePermit(exec('ls'), ctx)).toMatchObject({ allow: true });
  });
});

describe('F-12 CLI settings of the copy are not editable', () => {
  it.each([
    ['settings.json', '.claude/settings.json'],
    ['settings.local.json absolute', join(copyRoot, '.claude', 'settings.local.json')],
    ['a hook script', '.claude/hooks/pre.mjs'],
    ['the directory itself', '.claude'],
  ])('%s → refused', (_form, target) => {
    expect(decidePermit(ask('edit', target), ctx)).toMatchObject({
      allow: false,
      code: 'cli-config',
    });
  });

  it.runIf(isWin)('upper-case .CLAUDE on Windows → refused', () => {
    expect(decidePermit(ask('edit', '.CLAUDE\\settings.json'), ctx)).toMatchObject({
      code: 'cli-config',
    });
  });

  it.each([
    ['a nested package .claude', 'packages/a/.claude/notes.md'],
    ['a file named like it', '.claude-notes.md'],
  ])('%s → allowed', (_form, target) => {
    expect(decidePermit(ask('edit', target), ctx)).toMatchObject({ allow: true });
  });
});
