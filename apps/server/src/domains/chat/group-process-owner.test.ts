import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  groupMarkEnv,
  groupProcessMark,
  launchedCommandOf,
  processLabel,
  provenOwn,
  ranInCopy,
  windowsArgv,
  type OwnerRow,
} from './group-process-owner.ts';

/**
 * Чей процесс гасит группа (D-1, 24.10): группа завела `(vite --port 5284 &)`,
 * оболочка-посредник вышла, vite остался сиротой — и свой dev-сервер судился
 * чужим, вызов ждал человека. Своё доказывают метка группы и текст запуска.
 */

/** FILETIME-тики снимка ОС для мига `ms` (Unix): так `created` пишет снимок Windows. */
const filetime = (ms: number): bigint => BigInt(ms + 11_644_473_600_000) * 10_000n;

const LAUNCHED = '(npx vite --port 5284 --strictPort > .agent/tmp/vite.log 2>&1 &)';
/** Заглушка `bash.exe`, которую Git Bash держит за фоновым звеном, — дословная форма CLI. */
const STUB =
  '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval \'' +
  LAUNCHED +
  '\' < /dev/null && pwd -P >| /tmp/claude-cwd"';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function copyTranscripts(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-owner-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'sess.jsonl'), `${lines.join('\n')}\n`);
  return dir;
}

const callLine = (command: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });

describe('метка группы', () => {
  it('своя у каждой группы, имя переменной окружения', () => {
    const mark = groupProcessMark('parent-1', 1);
    expect(mark).toMatch(/^AGENTDECK_OWNER_[0-9A-F]{16}$/);
    expect(groupProcessMark('parent-1', 1)).toBe(mark);
    expect(groupProcessMark('parent-1', 2)).not.toBe(mark);
    expect(groupProcessMark('parent-2', 1)).not.toBe(mark);
  });

  /** Окружение прогона группы чужого CLI (P-06): та же метка, что у групп Claude. */
  it('окружение звена группы несёт её метку; звено без номера группы — без метки', () => {
    expect(groupMarkEnv({ parentChatId: 'parent-1', groupIndex: 1 })).toEqual({
      [groupProcessMark('parent-1', 1)]: '1',
    });
    expect(groupMarkEnv({ parentChatId: 'parent-1' })).toEqual({});
  });
});

describe('текст запуска из командной строки', () => {
  it('слова Windows: кавычки и обратные косые', () => {
    expect(windowsArgv('"C:\\Program Files\\x.exe" -c "echo \\"hi\\"" tail')).toEqual([
      'C:\\Program Files\\x.exe',
      '-c',
      'echo "hi"',
      'tail',
    ]);
    expect(windowsArgv('a\\\\"b c"')).toEqual(['a\\b c']);
  });

  it('обёртка Bash-инструмента CLI → команда знак в знак', () => {
    expect(launchedCommandOf(STUB, 'win32')).toBe(LAUNCHED);
    // CLI экранирует одинарную кавычку как '\'' — команда восстанавливается.
    const quoted = `bash -c "eval 'echo '\\''a'\\''' < /dev/null"`;
    expect(launchedCommandOf(quoted, 'win32')).toBe("echo 'a'");
    // Живая заглушка Claude Code (24.10): `'` внутри — `'"'"'`, а `"` для Windows — `\"`.
    const live = `bash.exe -c "eval '(node -e \\"require('\\"'\\"'http'\\"'\\"').listen(5391)\\" &)' < /dev/null && pwd -P"`;
    expect(launchedCommandOf(live, 'win32')).toBe(`(node -e "require('http').listen(5391)" &)`);
    // Подстановка в двойных кавычках меняет текст — знак в знак не сверить.
    expect(launchedCommandOf(`bash -c "eval 'a'\\"$X\\"'b' < /dev/null"`, 'win32')).toBeUndefined();
    expect(launchedCommandOf(`/bin/bash -c eval '${LAUNCHED}' < /dev/null`, 'linux')).toBe(
      LAUNCHED,
    );
  });

  it('не обёртка — `undefined`', () => {
    expect(launchedCommandOf('node C:/x/vite.js --port 5284', 'win32')).toBeUndefined();
    expect(launchedCommandOf('"bash.exe" -lc "npm run dev"', 'win32')).toBeUndefined();
  });
});

describe('ranInCopy — вызов записан в транскриптах копии', () => {
  it('ровно эта команда — да; другая — нет; файл старше запуска не читается', () => {
    const dir = copyTranscripts([callLine(LAUNCHED)]);
    const since = Date.now() - 5 * 60_000;
    expect(ranInCopy(dir, LAUNCHED, since)).toBe(true);
    expect(ranInCopy(dir, `${LAUNCHED} `, since)).toBe(false);
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(join(dir, 'sess.jsonl'), old, old);
    expect(ranInCopy(dir, LAUNCHED, since)).toBe(false);
  });

  it('транскрипты субагентов в подкаталогах тоже', () => {
    const dir = copyTranscripts([]);
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sess', 'subagents', 'agent-1.jsonl'), callLine(LAUNCHED));
    expect(ranInCopy(dir, LAUNCHED, Date.now() - 60_000)).toBe(true);
  });
});

describe('provenOwn', () => {
  const t = Date.now() - 10 * 60_000;
  /** 500 — заглушка bash, родитель 4 вышел; 501 — vite под ней (сирота группы). */
  const ORPHAN: OwnerRow[] = [
    { pid: 500, ppid: 4, created: filetime(t), command: STUB },
    { pid: 501, ppid: 500, created: filetime(t + 1000), command: 'node vite.js --port 5284' },
  ];
  /** 700 — терминал владельца (жив), 701 — его оболочка с тем же текстом, 702 — его vite. */
  const OWNER: OwnerRow[] = [
    { pid: 700, ppid: 0, created: filetime(t - 60_000), command: 'WindowsTerminal.exe' },
    { pid: 701, ppid: 700, created: filetime(t), command: STUB },
    { pid: 702, ppid: 701, created: filetime(t + 1000), command: 'node vite.js --port 5284' },
  ];
  const dirWithCall = () => copyTranscripts([callLine(LAUNCHED)]);

  it('живое дерево и метка группы — свои без текста запуска', () => {
    expect(provenOwn(ORPHAN, [501], { tree: new Set([501]) })).toEqual(new Set([501]));
    expect(provenOwn(ORPHAN, [501], { tree: new Set(), marks: new Map([[501, true]]) })).toEqual(
      new Set([501]),
    );
    expect(provenOwn(ORPHAN, [501], { tree: new Set([500]) })).toEqual(new Set([501]));
  });

  it('сирота, чей запуск записан в копии, — своя (D-1)', () => {
    const own = provenOwn(ORPHAN, [501], {
      tree: new Set(),
      transcriptDir: dirWithCall(),
      platform: 'win32',
    });
    expect(own).toEqual(new Set([501]));
  });

  it('тот же текст, но цепочка доходит до живого чужого процесса — не своя', () => {
    const own = provenOwn(OWNER, [702], {
      tree: new Set(),
      transcriptDir: dirWithCall(),
      platform: 'win32',
    });
    expect(own.size).toBe(0);
  });

  it('номер родителя занят позже ребёнка — цепочка оборвана, сирота', () => {
    const reused: OwnerRow[] = [
      { pid: 4, ppid: 0, created: filetime(t + 5000), command: 'later.exe' },
      ...ORPHAN,
    ];
    const own = provenOwn(reused, [501], {
      tree: new Set(),
      transcriptDir: dirWithCall(),
      platform: 'win32',
    });
    expect(own).toEqual(new Set([501]));
  });

  it('сирота без записи вызова или без каталога транскриптов — не своя', () => {
    const empty = copyTranscripts([callLine('npm run build')]);
    const common = { tree: new Set<number>(), platform: 'win32' };
    expect(provenOwn(ORPHAN, [501], { ...common, transcriptDir: empty }).size).toBe(0);
    expect(provenOwn(ORPHAN, [501], common).size).toBe(0);
    expect(provenOwn(ORPHAN, [501], { ...common, marks: new Map([[501, false]]) }).size).toBe(0);
  });
});

describe('processLabel', () => {
  it('строка без лишних пробелов, длинная — с обрезкой', () => {
    expect(processLabel({ pid: 1, ppid: 0, created: 0n, command: 'node  vite.js\n--port 1' })).toBe(
      'node vite.js --port 1',
    );
    expect(processLabel({ pid: 1, ppid: 0, created: 0n, command: 'x'.repeat(300) })).toHaveLength(
      120,
    );
    expect(processLabel(undefined)).toBe('unknown command');
  });
});
