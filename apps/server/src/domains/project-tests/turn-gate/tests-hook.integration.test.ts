import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Хук блока «Тесты» живым процессом (`node tools/tests-hook.mjs`), как его зовёт
 * Claude Code: вход JSON на stdin, журнал хода — настоящий JSONL. Подменена только
 * граница — сам журнал пишется тестом, а не CLI.
 */
const HOOK = resolve(__dirname, '../../../../../../tools/tests-hook.mjs');
const CLI = resolve(__dirname, '../../../../../../tools/tests-cli.mjs');

function hook(event: string, input: object, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', AGENTDECK_TESTS_NOTE: '', ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('tests-hook: проверка конца хода', () => {
  let root = '';
  let project = '';
  let transcript = '';
  const start = new Date(Date.now() - 60_000).toISOString();
  const edit = new Date(Date.now() - 30_000).toISOString();

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-hook-')));
    project = join(root, 'proj');
    mkdirSync(join(project, 'src'), { recursive: true });
    transcript = join(root, 'session.jsonl');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const turn = (tools: { name: string; input: object }[]) =>
    writeFileSync(
      transcript,
      [
        {
          type: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'old turn' },
        },
        { type: 'user', timestamp: start, message: { role: 'user', content: 'поправь вход' } },
        {
          type: 'assistant',
          timestamp: edit,
          message: {
            role: 'assistant',
            content: tools.map((tool) => ({ type: 'tool_use', id: 'x', ...tool })),
          },
        },
        {
          type: 'user',
          timestamp: edit,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );
  const stop = (extra: object = {}) =>
    hook('stop', { transcript_path: transcript, cwd: project, ...extra });

  it('правка кода в пустом блоке — пропуск с командой case; повтор того же хода — тишина', () => {
    turn([{ name: 'Edit', input: { file_path: join(project, 'src', 'login.ts') } }]);
    const first = stop();
    expect(first.code, first.err).toBe(0);
    const verdict = JSON.parse(first.out) as { decision: string; reason: string };
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toContain('no test case yet');
    expect(verdict.reason).toContain('"codePaths":["src/login.ts"]');
    expect(stop({ stop_hook_active: true }).out).toBe('');
  });

  it('ход без правок, правка заметок — тишина', () => {
    turn([{ name: 'Read', input: { file_path: join(project, 'src', 'login.ts') } }]);
    expect(stop().out).toBe('');
    turn([{ name: 'Write', input: { file_path: join(project, '.agent', 'notes.md') } }]);
    expect(stop().out).toBe('');
  });

  /**
   * 3.4 плана экономии на настоящем git: одноразовый скрипт снимков, которого
   * git не знает, ход не останавливает; тот же файл, добавленный в индекс, — код.
   */
  it('неотслеживаемый скрипт снимков — тишина; добавленный в git — пропуск с командой case', () => {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: project, encoding: 'utf8' }).status;
    expect(git('init', '-q')).toBe(0);
    mkdirSync(join(project, 'e2e'), { recursive: true });
    writeFileSync(join(project, 'e2e', 'login-shots.mjs'), 'console.log(1);\n');
    turn([{ name: 'Write', input: { file_path: join(project, 'e2e', 'login-shots.mjs') } }]);
    expect(stop().out).toBe('');
    expect(git('add', 'e2e/login-shots.mjs')).toBe(0);
    const out = stop().out;
    expect(out).toContain('"decision":"block"');
    const tracked = JSON.parse(out) as { decision: string; reason: string };
    expect(tracked.decision).toBe('block');
    expect(tracked.reason).toContain('"codePaths":["e2e/login-shots.mjs"]');
  });

  it('ручной кейс на файл записан агентом через tests-cli record — ход закрыт', () => {
    createGroup(project, 'auth', 'Auth');
    upsertCase(
      project,
      'auth',
      { title: 'Вход', steps: ['войти'], codePaths: ['src/login.ts'] },
      start,
    );
    turn([{ name: 'Edit', input: { file_path: join(project, 'src', 'login.ts') } }]);
    const before = stop();
    expect(before.out).toContain('record --project');
    const recorded = spawnSync(
      process.execPath,
      [CLI, 'record', 'auth:auth-001=passed', '--note', 'вошёл', '--project', project],
      { encoding: 'utf8' },
    );
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(stop().out).toBe('');
  });

  it('начало сессии: строка о блоке; в чате панели (строка уже в промпте) — тишина', () => {
    const line = hook('session', { cwd: project });
    expect(line.out).toContain('AgentDeck Tests block is on');
    expect(line.out).toContain('one step per behaviour, each expected = what is actually seen');
    expect(line.out).toContain(`--project "${project}"`);
    // L6.2: прогон — тронутых кейсов, не всей группы (группа может нести живые QA).
    expect(line.out).toContain(`run --project "${project}" --case <g>:<id>`);
    expect(line.out).not.toMatch(/run --project "[^"]*" --group/);
    expect(hook('session', { cwd: project }, { AGENTDECK_TESTS_NOTE: '1' }).out).toBe('');
  });
});
