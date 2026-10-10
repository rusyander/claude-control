import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeKit } from './compose.ts';
import { builtinKitDir } from './service.ts';

/**
 * Хуки набора — настоящие скрипты из приложения. `verdict` берётся импортом
 * того же файла, что запускает CLI, а сам запуск — дочерним процессом с тем
 * stdin и окружением, которые даёт CLI: проверяется ровно то, что исполнится.
 */

const HOOKS = join(builtinKitDir(), 'hooks');
const GUARD = join(HOOKS, 'guard-destructive.mjs');
const SESSION = join(HOOKS, 'session-rules.mjs');

const guard = (await import(pathToFileURL(GUARD).href)) as {
  verdict: (command: string) => string | null;
  RULES: [RegExp, string][];
};

function runNode(script: string, input: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_KIT_VARIANT: '', ...env },
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('guard-destructive: verdict', () => {
  const asks = [
    'git push --force',
    'git push origin main --force',
    'git push -f origin main',
    'git push --force-with-lease origin feat',
    'git reset --hard',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'git clean -xdf',
    'git clean -d -f',
    'git clean --force',
    'git checkout .',
    'git checkout -- .',
    'git branch -D feat',
    'rm -rf /',
    'rm -rf /*',
    'rm -fr /',
    'rm -r /',
    'rm -r -f /',
    'rm -R ~',
    'rm -rf ${HOME}',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf ~/*',
    'rm -rf $HOME',
    'rm -rf $HOME/',
    'rm -rf C:\\',
    'rm -rf C:/',
    'cd x && rm -rf / && echo',
    'DROP TABLE users;',
    'drop database prod',
    'psql -c "TRUNCATE TABLE events"',
    'DROP SCHEMA public CASCADE',
  ];
  it.each(asks)('спрашивает: %s', (command) => {
    expect(guard.verdict(command)).toEqual(expect.any(String));
  });

  const passes = [
    'ls',
    'ls -la',
    'git status',
    'git push',
    'git push origin main',
    'git push -u origin feat',
    'git push origin main && rm -f tmp.txt',
    'git push origin main; ls -f',
    'git reset --soft HEAD~1',
    'git reset HEAD file.ts',
    'git clean -n',
    'git clean -dn',
    'git checkout main',
    'git checkout -- src/a.ts',
    'git checkout ./src',
    'git branch -d merged',
    'rm -rf node_modules',
    'rm -rf ./dist',
    'rm -rf /tmp/build',
    'rm -rf ~/projects/old',
    'rm -rf $HOME/.cache/x',
    'rm -rf C:\\Users\\me\\tmp',
    'rm -f /',
    'rm file.txt',
    'pnpm test',
    'grep -r "table" src',
    'SELECT * FROM drops',
  ];
  it.each(passes)('пропускает молча: %s', (command) => {
    expect(guard.verdict(command)).toBeNull();
  });
});

describe('guard-destructive: запуск так, как его зовёт CLI', () => {
  it('опасная команда Bash — permissionDecision ask с причиной', () => {
    const out = runNode(
      GUARD,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }),
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'agentdeck kit: git reset --hard drops uncommitted changes',
      },
    });
  });

  // Форма вызова — как её на деле отдаёт хуку qwen-code 0.25.0 (снято зондом 07.10).
  it('Qwen Code зовёт оболочку run_shell_command — тот же ask', () => {
    const out = runNode(
      GUARD,
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        permission_mode: 'yolo',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git reset --hard', is_background: false, description: 'reset' },
        tool_call_id: 'call1',
      }),
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('безопасная команда, чужой инструмент и мусор на входе — без вывода', () => {
    for (const input of [
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      JSON.stringify({ tool_name: 'Write', tool_input: { command: 'git reset --hard' } }),
      JSON.stringify({ tool_name: 'write_file', tool_input: { command: 'git reset --hard' } }),
      'не json',
      'null',
      '42',
      '',
    ]) {
      const out = runNode(GUARD, input);
      expect(out.status).toBe(0);
      expect(out.stdout).toBe('');
    }
  });
});

describe('session-rules: правила набора контекстом сессии', () => {
  const contextOf = (stdout: string): string =>
    (
      JSON.parse(stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      }
    ).hookSpecificOutput.additionalContext;

  it('без варианта — только общие правила', () => {
    const out = runNode(SESSION, '{}');
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = contextOf(out.stdout);
    expect(text).toContain('# agentdeck kit rules');
    expect(text).not.toContain('Local model discipline');
  });

  it('AGENTDECK_KIT_VARIANT=local — и дисциплина локальной модели, последней', () => {
    const text = contextOf(runNode(SESSION, '{}', { AGENTDECK_KIT_VARIANT: 'local' }).stdout);
    expect(text).toContain('# agentdeck kit rules');
    expect(text.indexOf('Local model discipline')).toBeGreaterThan(
      text.indexOf('agentdeck kit rules'),
    );
  });

  it('standard — тот же текст, что без варианта', () => {
    expect(contextOf(runNode(SESSION, '{}', { AGENTDECK_KIT_VARIANT: 'standard' }).stdout)).toBe(
      contextOf(runNode(SESSION, '{}').stdout),
    );
  });

  it('из собранного набора: выключенное правило не читается, правка «моё» читается', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-kit-hooks-')));
    try {
      const mine = join(root, 'mine');
      mkdirSync(join(mine, 'rules'), { recursive: true });
      writeFileSync(join(mine, 'rules', 'local.md'), '# МОЯ ДИСЦИПЛИНА\n');
      const target = composeKit({
        builtinDir: builtinKitDir(),
        mineDir: mine,
        disabled: ['rules/standard.md'],
        yielded: [],
        target: join(root, 'effective', 'ours', 'agentdeck-kit'),
      });
      const text = contextOf(
        runNode(join(target, 'hooks', 'session-rules.mjs'), '{}', {
          AGENTDECK_KIT_VARIANT: 'local',
        }).stdout,
      );
      // Корень набора идёт первой строкой: навыки пишут `<kit>/tools/…`, и модели нужен путь.
      expect(
        text.startsWith(`Kit root (\`<kit>\` in skill text): ${target.split('\\').join('/')}\n\n`),
      ).toBe(true);
      expect(text).not.toContain('# agentdeck kit rules');
      expect(text).toContain('# Safety');
      expect(text.endsWith('\n\n# МОЯ ДИСЦИПЛИНА')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('local-discipline: на локальной модели без фоновой работы', () => {
  const ITEM = join(HOOKS, 'local-discipline.mjs');
  const DISPATCH = join(HOOKS, 'lib', 'run.mjs');
  const LOCAL = { AGENTDECK_KIT_VARIANT: 'local' };
  const call = (tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's1' });
  const decision = (stdout: string): string | undefined =>
    stdout.trim()
      ? (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision
      : undefined;

  it('фоновая команда и фоновый субагент — отказ с причиной', () => {
    const shell = runNode(
      ITEM,
      call('Bash', { command: 'npm test', run_in_background: true }),
      LOCAL,
    );
    expect(decision(shell.stdout)).toBe('deny');
    expect(shell.stdout).toContain('without run_in_background');
    const agent = call('Agent', { prompt: 'x', description: 'y', run_in_background: true });
    expect(decision(runNode(ITEM, agent, LOCAL).stdout)).toBe('deny');
  });

  it('форма Qwen Code (`run_shell_command`) — тот же отказ', () => {
    const input = call('run_shell_command', { command: 'npm test', run_in_background: true });
    expect(decision(runNode(ITEM, input, LOCAL).stdout)).toBe('deny');
  });

  it('обычный вызов на локальной модели и фоновый в облаке — тишина', () => {
    expect(runNode(ITEM, call('Bash', { command: 'npm test' }), LOCAL).stdout.trim()).toBe('');
    const background = call('Bash', { command: 'npm test', run_in_background: true });
    expect(runNode(ITEM, background).stdout.trim()).toBe('');
  });

  it('через диспетчер событий, как его зовёт hooks.json', () => {
    const background = call('Bash', { command: 'npm run dev', run_in_background: true });
    const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
      input: background,
      encoding: 'utf8',
      env: { ...process.env, ...LOCAL },
      timeout: 15_000,
    });
    expect(decision(out.stdout)).toBe('deny');
  });
});

describe('spawn-cost-guard: субагент на локальной модели', () => {
  const SPAWN = join(HOOKS, 'spawn-cost-guard.mjs');
  // Форма вызова — как её отдал хуку qwen-code 0.25.0 в живом прогоне 08.10.
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'agent',
    tool_input: { description: 'Fix money.js module', prompt: 'Fix src/money.js' },
    session_id: 's1',
  });
  const state = mkdtempSync(join(realpathSync(tmpdir()), 'kit-spawn-'));

  it('в облаке субагент без модели — вопрос', () => {
    const out = runNode(SPAWN, input, { AGENTDECK_KIT_STATE: state });
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('AGENTDECK_KIT_VARIANT=local — без вопроса: платить не за что, меньшей модели нет', () => {
    const out = runNode(SPAWN, input, {
      AGENTDECK_KIT_STATE: state,
      AGENTDECK_KIT_VARIANT: 'local',
    });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});
