import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchGateContext,
  isMainWorkingCopy,
  isWritingCall,
  mainCopyTargetOf,
  suggestBranchName,
} from './ChatBranchGate.ts';

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

  /**
   * Живой прогон 24.09.2026: оба чтения ниже остановили прогон в основной
   * копии и увели его в копию с веткой. Таблица — в обе стороны: починка не
   * имеет права ослепить ворота на настоящую запись рядом.
   */
  it('сброс потока в никуда и имя каталога с `cp-` — чтение, запись рядом — по-прежнему запись', () => {
    const reads = [
      'ls "$NVM_HOME" 2>/dev/null',
      'cd cp-admin-ui && git status',
      'cd cp-admin-ui/src && rg "useForm" .',
      'git log --oneline -5 2>&1 | head',
      'npm ls react &>/dev/null; echo $?',
      'where node 2>nul',
      'Get-ChildItem 2>$null',
      'node -e "console.log([1].map((a) => a))"',
      'cat install-notes.md',
      'rg -n "tee-shirt" src',
      'ls ./patches/dd-helper',
      "ls '/dev/null'",
    ];
    for (const command of reads) {
      expect({ command, write: isWritingCall('Bash', { command }) }).toEqual({
        command,
        write: false,
      });
    }

    const writes = [
      'ls > out.txt',
      'ls 2>/dev/null > out.txt',
      'npm test 2> err.log',
      'echo a>b',
      'echo x >> /dev/null.txt',
      'echo x > nul.txt',
      'cd cp-admin-ui && cp a.ts b.ts',
      '(cd x && mv a b)',
      'cp -r src dst',
      'find . -name "*.ts" | xargs cp -t out',
      'node build.mjs | tee',
      'dd if=a of=b',
      'npm install',
    ];
    for (const command of writes) {
      expect({ command, write: isWritingCall('Bash', { command }) }).toEqual({
        command,
        write: true,
      });
    }
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

  it('ссылка в задании имени не даёт — остаётся ключ задачи из неё', () => {
    expect(
      suggestBranchName('https://tracker.example.com/browse/PROJ-1064 поправь форму', 'abc123def'),
    ).toBe('agent/proj-1064-poprav-formu-123def');
    // Ключа в ссылке нет — от неё не остаётся ничего, имя берётся из текста.
    expect(
      suggestBranchName(
        'https://tracker.example.com/secure/Dashboard.jspa\nпочини вход',
        'abc123def',
      ),
    ).toBe('agent/pochini-vhod-123def');
    expect(suggestBranchName('https://example.com/x', 'zzz999')).toBe('agent/chat-zzz999');
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

  /**
   * Итоговая проверка 25.09 (D4): группа из своей копии записала абсолютным
   * путём в `.agent/` основной копии — ворота смотрели только на каталог прогона.
   */
  describe('правка из копии в основную копию', () => {
    const intoMain = (tool: string, input: unknown, cwd = copy): string | undefined =>
      mainCopyTargetOf(cwd, tool, input);
    const slashed = (path: string): string => path.split('\\').join('/').toLowerCase();

    it('инструмент правки с путём в основную копию — пойман, назван её корень', () => {
      const target = join(main, '.agent', 'notes.agent.md');
      expect(slashed(intoMain('Write', { file_path: target }) ?? '')).toBe(
        slashed(realpathSync.native(main)),
      );
      expect(intoMain('write_file', { path: join(main, 'a.txt') })).toBeDefined();
    });

    it('правка внутри своей копии, относительный путь и чтение — не в счёт', () => {
      expect(intoMain('Edit', { file_path: join(copy, 'a.txt') })).toBeUndefined();
      expect(intoMain('Edit', { file_path: 'a.txt' })).toBeUndefined();
      expect(intoMain('Read', { file_path: join(main, 'a.txt') })).toBeUndefined();
    });

    it('оболочка: запись по пути основной копии поймана, по своему — нет', () => {
      // Путь в команде — настоящий, как его отдаёт git (без короткого имени Windows).
      const real = realpathSync.native(main);
      expect(
        intoMain('Bash', { command: `echo x > "${slashed(real)}/.agent/n.md"` }),
      ).toBeDefined();
      expect(intoMain('Bash', { command: `echo x > ${join(real, 'b.txt')}` })).toBeDefined();
      expect(intoMain('Bash', { command: `echo x > ${join(copy, 'b.txt')}` })).toBeUndefined();
      expect(intoMain('Bash', { command: `cat ${join(main, 'a.txt')}` })).toBeUndefined();
    });

    it('прогон в основной копии — решают прежние ворота, не эта проверка', () => {
      expect(intoMain('Write', { file_path: join(main, 'a.txt') }, main)).toBeUndefined();
    });
  });
});

describe('ворота ветки: работа отдана группам (Д15)', () => {
  const group = (index: number, chatId: string) => ({
    index,
    title: `Группа ${index + 1}`,
    branch: `agent/g${index + 1}`,
    after: [],
    status: 'started' as const,
    chatId,
  });
  const split = { parentChatId: 'p', order: [0, 1], groups: [group(0, 'c1'), group(1, 'c2')] };

  it('две ветки MR у детей — базу наугад не выбираем', () => {
    const context = branchGateContext(split, (chatId) => ({ branch: `mr-${chatId}` }));
    expect(context?.children.map((child) => child.number)).toEqual([1, 2]);
    expect(context?.base).toBeUndefined();
  });

  it('одна ветка MR на всех — от неё и отводим; без разделения контекста нет', () => {
    expect(branchGateContext(split, () => ({ branch: 'mr', remote: 'origin' }))?.base).toBe(
      'origin/mr',
    );
    expect(branchGateContext(undefined, () => undefined)).toBeUndefined();
  });
});
