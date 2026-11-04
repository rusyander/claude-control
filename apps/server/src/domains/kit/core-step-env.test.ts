import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Сессия шага ядра узнаётся по окружению, которое собирает само ядро (`coreVarsEnv` переходника
 * запуска): `AGENTDECK_STEP_KIND`. Прежний признак группы панели `AGENTDECK_GROUP_STAGE` с F1 никто
 * не ставит — ветки на нём были мёртвыми. Окружение берётся у настоящего модуля ядра дочерним
 * процессом (статический импорт ядра из панели запрещён границей `panel-apart-from-core`), затем
 * хуки набора идут через диспетчер `run.mjs`, как их зовёт hooks.json.
 */

// AGENTDECK_KIT_UNDER_TEST — копия набора для прогона «красный до» против старого кода; без неё — встроенный.
const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const CORE_ENV = resolve(import.meta.dirname, '../../../../core/src/adapters/launcher/env.ts');
const dir = mkdtempSync(join(tmpdir(), 'kit-core-step-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Окружение сессии шага так, как его отдаёт ядро. */
function coreEnv(stepKind: string): Record<string, string> {
  const script =
    `const m = await import(${JSON.stringify(pathToFileURL(CORE_ENV).href)});` +
    `const core = { taskId: 't1', stepId: 's1', stepKind: ${JSON.stringify(stepKind)},` +
    ` coreUrl: 'http://127.0.0.1:1', sessionToken: 'tok' };` +
    `process.stdout.write(JSON.stringify(m.coreVarsEnv(core, ${JSON.stringify(dir)}, 'state.json')));`;
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (out.status !== 0) throw new Error(`coreVarsEnv: ${out.stderr}`);
  return JSON.parse(out.stdout) as Record<string, string>;
}

const base = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTDECK_KIT_VARIANT: '',
    AGENTDECK_KIT_STATE: join(dir, 'state'),
  };
  // Набор, запущенный самой сессией шага ядра, не должен подмешать её переменные в «без ядра».
  for (const key of Object.keys(env))
    if (/^AGENTDECK_(STEP|TASK|SESSION_TOKEN)/.test(key)) delete env[key];
  return env;
};

function dispatch(
  event: string,
  cwd: string,
  payload: object,
  env: Record<string, string>,
): string {
  const r = spawnSync(process.execPath, [DISPATCH, event], {
    cwd,
    encoding: 'utf8',
    env: { ...base(), ...env },
    input: JSON.stringify({ cwd, ...payload }),
    timeout: 15_000,
  });
  return `${r.stdout}${r.stderr}`;
}

let n = 0;
function project(): string {
  const root = join(dir, `p${++n}`);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.agent'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'notes.md'),
    '# Notes\n\nWell over the size budget. '.repeat(600),
  );
  return root;
}

const docReview = (env: Record<string, string>) => {
  const root = project();
  return dispatch(
    'post-edit',
    root,
    {
      hook_event_name: 'PostToolUse',
      session_id: `core-step-${n}`,
      tool_name: 'Write',
      tool_input: { file_path: join(root, '.agent', 'notes.md'), content: 'x' },
    },
    env,
  );
};
const skillHint = (env: Record<string, string>) =>
  dispatch(
    'prompt',
    project(),
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: `core-step-${++n}`,
      prompt: 'сделай ревью моей ветки',
    },
    env,
  );

describe('сессия шага ядра: ревизия доков и подсказка навыка молчат, чат и сессия без ядра — нет', () => {
  it('окружение ядра несёт вид шага', () => {
    expect(coreEnv('implement').AGENTDECK_STEP_KIND).toBe('implement');
  });

  it.each(['implement', 'review', 'fix'])(
    'шаг %s: без ревизии доков и без подсказки навыка',
    (kind) => {
      const env = coreEnv(kind);
      expect(docReview(env)).not.toContain('[doc-daily-review]');
      expect(skillHint(env)).not.toContain('agentdeck-kit:deep-review');
    },
  );

  it('чат ядра (за панелью человек) и сессия без ядра — ревизия и подсказка звучат', () => {
    for (const env of [coreEnv('chat'), {}]) {
      expect(docReview(env)).toContain('[doc-daily-review]');
      expect(skillHint(env)).toContain('agentdeck-kit:deep-review');
    }
  });
});

/**
 * Ветки, перенаправленные с мёртвых признаков групп панели (`AGENTDECK_SPLIT_CHILD`,
 * `AGENTDECK_HEAVY_QUEUE_DIR`, `AGENTDECK_USER_MEMORY_OFF`) на вид шага ядра: до переноса шаг ядра
 * получал всё, что положено человеку, — эти проверки на старом наборе красные.
 */
const plain = (): Record<string, string> => ({});
const sides = (): [string, Record<string, string>][] => [
  ['без ядра', plain()],
  ['чат ядра', coreEnv('chat')],
];

describe('сессия шага ядра: строки для человека молчат, чат и сессия без ядра — нет', () => {
  // Вне шага вызов окружения на каждой стороне, чтобы транскрипт и сессия были свои.
  const clearAdvice = (env: Record<string, string>) => {
    const root = project();
    const payload = { hook_event_name: 'PostCompact', session_id: `advisor-${++n}` };
    dispatch('postcompact', root, payload, env);
    return dispatch('postcompact', root, payload, env);
  };
  const sessionStart = (env: Record<string, string>) =>
    dispatch(
      'session',
      project(),
      { hook_event_name: 'SessionStart', session_id: `start-${++n}`, source: 'startup' },
      env,
    );
  const grantRecorded = (env: Record<string, string>) => {
    const session = `grant-${++n}`;
    dispatch(
      'prompt',
      project(),
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt: 'агенты без вопроса на 2 ч',
      },
      env,
    );
    return existsSync(join(dir, 'state', 'grants', `spawn-${session}.json`));
  };
  // Окно 300k — порог «срочно» 261k; 200k выше пола 150k, но до срочного.
  const contextNudge = (env: Record<string, string>) => {
    const root = project();
    const transcript = join(dir, `ctx-${++n}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 199_990 } },
      })}\n`,
    );
    return dispatch(
      'post-any',
      root,
      {
        hook_event_name: 'PostToolUse',
        session_id: `ctx-${n}`,
        transcript_path: transcript,
        tool_name: 'Read',
        tool_input: { file_path: join(root, 'x') },
        tool_response: {},
      },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000', ...env },
    );
  };

  it.each(['implement', 'review', 'fix'])(
    'шаг %s: без «/clear», без строк старта, без записи разрешения, без раннего напоминания окна',
    (kind) => {
      const env = coreEnv(kind);
      expect(clearAdvice(env)).not.toContain('/clear');
      expect(sessionStart(env)).not.toContain('Project not onboarded');
      expect(grantRecorded(env)).toBe(false);
      expect(contextNudge(env)).not.toContain('[context-watch]');
    },
  );

  it.each(sides())(
    '%s: «/clear», строки старта, разрешение и напоминание окна на месте',
    (_, env) => {
      expect(clearAdvice(env)).toContain('/clear');
      expect(sessionStart(env)).toContain('Project not onboarded');
      expect(grantRecorded(env)).toBe(true);
      expect(contextNudge(env)).toContain('[context-watch]');
    },
  );
});

describe('rule-injector: повтор правила после сжатия — карточка только в шаге ядра', () => {
  const full = readFileSync(
    join(KIT, 'skills', 'situational-rules', 'references', 'docker-shared.md'),
    'utf8',
  ).trim();
  // Вывод хука — JSON: начало правила ищется в том же экранировании.
  const head = JSON.stringify(full.slice(0, 200)).slice(1, -1);
  /** Правило в первый раз, сжатие, правило снова — что пришло во второй раз. */
  const redelivery = (env: Record<string, string>) => {
    const root = project();
    const session = `card-${++n}`;
    const docker = () =>
      dispatch(
        'pre',
        root,
        {
          hook_event_name: 'PreToolUse',
          session_id: session,
          transcript_path: '',
          tool_name: 'Bash',
          tool_input: { command: 'docker run --rm hello-world' },
        },
        env,
      );
    expect(docker()).toContain(head);
    dispatch(
      'precompact',
      root,
      { hook_event_name: 'PreCompact', session_id: session, transcript_path: '' },
      env,
    );
    return docker();
  };

  it('шаг implement: короткая карточка с путём к файлу вместо правила целиком', () => {
    const card = redelivery(coreEnv('implement'));
    expect(card).not.toContain(head);
    expect(card).toMatch(/Read \S*situational-rules\/references\/docker-shared\.md/);
    expect(card.length).toBeLessThan(1600);
  });

  it.each(sides())('%s: правило снова целиком', (_, env) => {
    expect(redelivery(env)).toContain(head);
  });
});
