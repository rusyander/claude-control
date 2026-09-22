import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainWorkingCopy, isWritingCall, suggestBranchName } from './ChatBranchGate.ts';

describe('ворота ветки: что считается правкой', () => {
  it('инструменты правки — свои и чужих CLI', () => {
    for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(isWritingCall(name, { file_path: 'a.ts' })).toBe(true);
    // Чужой CLI зовёт правку по-своему, а ворота стоят на общем проводе.
    for (const name of ['apply_patch', 'write_file', 'replace', 'edit_file'])
      expect(isWritingCall(name, { path: 'a.ts' })).toBe(true);
  });

  it('чтение правкой не считается', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'read_file', 'WebFetch'])
      expect(isWritingCall(name, { file_path: 'a.ts' })).toBe(false);
  });

  it('команда оболочки: запись ловится, чтение — нет', () => {
    const writes = [
      'echo привет > file.txt',
      'cat a.ts >> b.ts',
      "sed -i 's/a/b/' file.ts",
      'git apply patch.diff',
      'cp a.ts b.ts',
      'node build.mjs | tee out.log',
    ];
    for (const command of writes) expect(isWritingCall('Bash', { command })).toBe(true);

    const reads = ['pnpm test', 'git status', 'rg "TODO" src', 'node --version', 'ls -la'];
    for (const command of reads) expect(isWritingCall('Bash', { command })).toBe(false);
  });

  it('команда приходит массивом argv — разбирается так же', () => {
    expect(isWritingCall('run_shell_command', { command: ['sed', '-i', 's/a/b/', 'f.ts'] })).toBe(
      true,
    );
  });
});

describe('ворота ветки: имя ветки по заданию', () => {
  it('русское задание переводится в латиницу', () => {
    expect(suggestBranchName('Перенос среды между CLI', 'abc123def')).toBe(
      'agent/perenos-sredy-mezhdu-cli-123def',
    );
  });

  it('два чата с одним заданием получают разные имена', () => {
    const first = suggestBranchName('правки по ревью', 'aaaaaa111111');
    const second = suggestBranchName('правки по ревью', 'bbbbbb222222');
    expect(first).not.toBe(second);
  });

  it('задание без букв — имя всё равно годное', () => {
    expect(suggestBranchName('!!! ???', 'zzz999')).toBe('agent/chat-zzz999');
    expect(suggestBranchName(undefined, 'zzz999')).toBe('agent/chat-zzz999');
  });
});

describe('ворота ветки: основная копия и копия', () => {
  let root: string;
  let main: string;
  let copy: string;
  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-branch-gate-'));
    main = join(root, 'repo');
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-b', 'main');
    git(main, 'config', 'user.email', 'probe@example.com');
    git(main, 'config', 'user.name', 'probe');
    writeFileSync(join(main, 'a.txt'), 'раз\n', 'utf8');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'первый');
    copy = join(root, 'repo-worktrees', 'work');
    git(main, 'worktree', 'add', '-b', 'work', copy);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('основная копия — да, копия — нет', () => {
    expect(isMainWorkingCopy(main)).toBe(true);
    // Признак берётся у git, а не из имени каталога: копия лежит где угодно.
    expect(isMainWorkingCopy(copy)).toBe(false);
  });

  it('каталог без git — не основная копия: делить там нечего', () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(isMainWorkingCopy(plain)).toBe(false);
  });
});
