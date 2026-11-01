import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { mapQwenPermission } from '../../adapters/qwen/permission.ts';
import { CLI_DEFAULT_WINDOW, canonicalPath, effectOf } from './effect-class.ts';

/**
 * Класс действия вызова (этап 8, зона W) над НАСТОЯЩИМ сопоставлением переходника Claude: сон
 * оболочки в любой записи — ожидание, чтение файла командой — чтение с окном, поиск — поиск,
 * неточный argv — просто исполнение (R8). Путь сравнивается в канонической форме (R9).
 */

const bash = (command: string): PermissionAsk =>
  mapClaudePermission({ tool: 'Bash', input: { command } });
const ps = (command: string): PermissionAsk =>
  mapClaudePermission({ tool: 'PowerShell', input: { command } });
const POSIX = { cwd: '/copy', os: 'linux' as const };

describe('stage 8 effect class of a tool call', () => {
  it('sleep forms of bash, PowerShell, cmd and ping are wait; a POSIX timeout wrapper is not', () => {
    for (const command of [
      'sleep 30',
      'sleep 1m 30s',
      'sleep 0.5',
      'timeout /t 30',
      'timeout /t 30 /nobreak',
      'ping -n 5 127.0.0.1',
      'ping -c 5 localhost',
      // Одиночный сон CLI блокируют (проба M) — ждут цепочкой: сон, затем только посмотреть.
      'sleep 21 && echo after',
      'sleep 30 && cat log.txt',
      'sleep 10; tail -n 20 out.log; sleep 10 && ls',
      'sleep 5 && grep -n done out.log',
    ])
      expect([command, effectOf(bash(command), POSIX).effectClass]).toEqual([command, 'wait']);
    for (const command of [
      'Start-Sleep 5',
      'Start-Sleep -s 5',
      'Start-Sleep -Seconds 5',
      'Start-Sleep -m 500',
      'Start-Sleep -Milliseconds 500',
    ])
      expect([command, effectOf(ps(command), POSIX).effectClass]).toEqual([command, 'wait']);
    for (const command of [
      'timeout 30 npm test',
      'ping -n 5 example.com',
      'sleep $N',
      // Цепочка, которая после сна что-то делает, пишет или берёт трубу, — уже не ожидание.
      'sleep 30 && npm test',
      'sleep 30 && cat log | grep x',
      'sleep 30 && cat log > out.txt',
      'echo start && sleep 30',
    ])
      expect([command, effectOf(bash(command), POSIX).effectClass]).not.toEqual([command, 'wait']);
  });

  it('un-piped file reads are read with their line window; piped or multi-file reads are exec', () => {
    const read = (command: string) => {
      const f = effectOf(bash(command), POSIX);
      return { cls: f.effectClass, target: f.target, range: f.range };
    };
    expect(read('cat README.md')).toEqual({ cls: 'read', target: '/copy/README.md', range: null });
    expect(read('head -n 20 src/a.ts')).toEqual({
      cls: 'read',
      target: '/copy/src/a.ts',
      range: { offset: null, limit: 20 },
    });
    expect(read('head -5 a.ts').range).toEqual({ offset: null, limit: 5 });
    expect(read('head a.ts').range).toEqual({ offset: null, limit: 10 });
    expect(read('tail -n 30 a.log').range).toEqual({ offset: -30, limit: null });
    expect(read('tail -n +40 a.log').range).toEqual({ offset: 40, limit: null });
    expect(read("sed -n '10,19p' a.ts").range).toEqual({ offset: 10, limit: 10 });
    expect(read("sed -n '7p' a.ts").range).toEqual({ offset: 7, limit: 1 });
    expect(effectOf(ps('Get-Content -Path a.ts -TotalCount 10'), POSIX)).toMatchObject({
      effectClass: 'read',
      target: '/copy/a.ts',
      range: { offset: null, limit: 10 },
    });
    expect(effectOf(ps('gc a.ts -Tail 5'), POSIX).range).toEqual({ offset: -5, limit: null });
    for (const command of ['cat a | head', 'cat a b', 'cat a > b', "sed -i 's/a/b/' a.ts"])
      expect([command, read(command).cls]).toEqual([command, 'exec']);
  });

  it('search commands and search tools are search; an inexact argv is plain exec with no argv', () => {
    expect(effectOf(bash('grep -rn foo src'), POSIX).effectClass).toBe('search');
    expect(effectOf(bash('rg foo'), POSIX).effectClass).toBe('search');
    expect(
      effectOf(mapClaudePermission({ tool: 'Grep', input: { pattern: 'x' } }), POSIX),
    ).toMatchObject({ effectClass: 'search' });
    expect(
      effectOf(mapClaudePermission({ tool: 'Glob', input: { pattern: '*.ts' } }), POSIX),
    ).toMatchObject({ effectClass: 'search' });
    // `gi\t push` разбор не берёт дословно (F-02): ни класса чтения/сна, ни отпечатка argv.
    const inexact = effectOf(bash('sle\\ep 30'), POSIX);
    expect(inexact).toMatchObject({ effectClass: 'exec', argv: null });
    // Скобки Bash раскрывает — argv неточен, суда нет (R8): недосрабатывание, а не ложный повтор.
    expect(effectOf(bash('node -e "process.exit(3)"'), POSIX)).toMatchObject({
      effectClass: 'exec',
      argv: null,
    });
    expect(effectOf(bash('node -e process.exitCode=3 && echo ok'), POSIX)).toMatchObject({
      effectClass: 'exec',
      argv: [
        ['node', '-e', 'process.exitCode=3'],
        ['echo', 'ok'],
      ],
    });
  });

  it('tool classes: read tool keeps the adapter window (absent = unknown), edit, todo, agent, mcp, net', () => {
    const readTool = (input: Record<string, unknown>) =>
      effectOf(mapClaudePermission({ tool: 'Read', input }), POSIX);
    expect(readTool({ file_path: '/copy/a.ts' })).toMatchObject({
      effectClass: 'read',
      target: '/copy/a.ts',
    });
    // Переходник Claude: ни одного поля окна — файл целиком (`null`), поля — окно.
    expect(readTool({ file_path: '/copy/a.ts' }).range).toBeNull();
    expect(readTool({ file_path: '/copy/a.ts', offset: 10, limit: 5 }).range).toEqual({
      offset: 10,
      limit: 5,
    });
    // Переходник окна не сообщил (поля нет) — `undefined`: перечитывание и большое чтение не судятся.
    const unknown: PermissionAsk = { action: 'read', target: '/copy/a.ts', tool: 'X', display: '' };
    expect(effectOf(unknown, POSIX).range).toBeUndefined();
    const ranged: PermissionAsk = {
      action: 'read',
      target: '/copy/a.ts',
      tool: 'Read',
      display: 'Read',
      range: { offset: 5, limit: 10 },
    };
    expect(effectOf(ranged, POSIX).range).toEqual({ offset: 5, limit: 10 });
    expect(effectOf({ ...ranged, range: null }, POSIX).range).toBeNull();
    // Qwen `read_file` без окна режет большой файл сам (проба M) — окно CLI, а не «целиком».
    const qwenRead = (input: Record<string, unknown>) =>
      effectOf(mapQwenPermission({ tool: 'read_file', input }), POSIX);
    expect(qwenRead({ file_path: '/copy/big.txt' })).toMatchObject({
      effectClass: 'read',
      target: '/copy/big.txt',
      range: CLI_DEFAULT_WINDOW,
    });
    expect(qwenRead({ file_path: '/copy/big.txt' }).range).not.toBeNull();
    const qwenRanged = qwenRead({ file_path: '/copy/big.txt', offset: 10, limit: 5 }).range;
    expect(qwenRanged).not.toEqual(CLI_DEFAULT_WINDOW);
    expect(qwenRanged).not.toBeNull();
    const cls = (tool: string, input: Record<string, unknown> = {}) =>
      effectOf(mapClaudePermission({ tool, input }), POSIX).effectClass;
    expect(cls('Edit', { file_path: 'a.ts' })).toBe('edit');
    expect(cls('TodoWrite')).toBe('todo');
    expect(cls('ToolSearch')).toBe('conversation');
    expect(cls('Agent', { subagent_type: 'x' })).toBe('agent');
    expect(cls('mcp__agentdeck__step_done')).toBe('mcp');
    expect(cls('WebFetch', { url: 'https://example.com' })).toBe('net');
    expect(cls('Skill', { skill: 's' })).toBe('other');
  });

  it('R9 canonical path: git-bash /c/ and C:\\ and \\\\?\\ forms are one Windows key; POSIX keeps case', () => {
    const forms = ['/c/Work/Repo/README.md', 'C:\\work\\repo\\readme.md', 'c:/WORK/repo/README.md'];
    const keys = new Set(forms.map((p) => canonicalPath(p, null, 'win32')));
    keys.add(canonicalPath('\\\\?\\C:\\Work\\Repo\\README.md', null, 'win32'));
    keys.add(canonicalPath('README.md', 'C:\\Work\\Repo', 'win32'));
    expect([...keys]).toEqual(['c:\\work\\repo\\readme.md']);
    expect(canonicalPath('README.md', '/copy', 'linux')).toBe('/copy/README.md');
    expect(canonicalPath('/copy/ReadMe.md', null, 'linux')).not.toBe(
      canonicalPath('/copy/readme.md', null, 'linux'),
    );
  });

  it('background-wait tools named by the probe are wait for both CLIs, even with a command input', () => {
    // Monitor несёт команду until-цикла — класс решает имя инструмента, не разбор команды.
    const claudeWaits = [
      mapClaudePermission({ tool: 'Monitor', input: { command: 'until [ -f done ]; do :; done' } }),
      mapClaudePermission({ tool: 'ScheduleWakeup', input: { delaySeconds: 60 } }),
    ];
    const qwenWaits = [
      mapQwenPermission({ tool: 'monitor', input: { command: 'type out.log' } }),
      mapQwenPermission({ tool: 'loop_wakeup', input: {} }),
    ];
    for (const ask of [...claudeWaits, ...qwenWaits])
      expect([ask.tool, effectOf(ask, POSIX).effectClass]).toEqual([ask.tool, 'wait']);
    for (const ask of [
      mapClaudePermission({ tool: 'TaskStop', input: { task_id: 'b1' } }),
      mapQwenPermission({ tool: 'task_stop', input: {} }),
    ])
      expect([ask.tool, effectOf(ask, POSIX).effectClass]).not.toEqual([ask.tool, 'wait']);
    // Имена вкалываются: пустой набор — опрос виден только по снам оболочки.
    expect(
      effectOf(claudeWaits[0] as PermissionAsk, { ...POSIX, pollTools: new Set() }),
    ).not.toMatchObject({
      effectClass: 'wait',
    });
  });
});
