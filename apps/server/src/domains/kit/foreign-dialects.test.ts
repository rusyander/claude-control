import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Кит на CLI, которые панель не запускает с набором, а человек ставит вариант руками
 * (`variants/<cli>/`): Gemini CLI, Goose, Kimi Code, OpenCode. Каждый вход — в форме из
 * опубликованной документации этого CLI, ответ — в форме, которую этот CLI читает:
 * Gemini и Goose — `{decision:'block'}`, Kimi и прослойка OpenCode — отказ Claude
 * (`hookSpecificOutput.permissionDecision`). `KIT_UNDER_TEST` — другая копия кита (красный прогон
 * по киту до диалектов).
 */

const KIT = resolve(process.env.KIT_UNDER_TEST || builtinKitDir());
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-foreign-'));
const STATE = join(dir, 'state');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Проект вне временного каталога: охранники пропускают пути во временных папках. */
const PROJECT = 'C:/work/proj';
const SED = `sed -i 's/a/b/' src/x.ts`;
/** Корень репозитория — по нему охранник раскладки находит, где агентским документам место. */
const repo = join(dir, 'repo');
mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
const SPAWN = 'Do X. [return-format] deliverable to .agent/tmp/x.md [no-subagents]';

type Out = { raw: string; json: Record<string, unknown> | null };

function run(event: string, payload: object, cli?: string): Out {
  const res = spawnSync(process.execPath, [DISPATCH, event, ...(cli ? [`--cli=${cli}`] : [])], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_CLI: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: STATE,
    },
    timeout: 20_000,
  });
  const raw = res.stdout.trim();
  let json: Record<string, unknown> | null;
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { raw, json };
}

/** Отказ Claude-формы: причина или undefined. */
const denied = (out: Out): string | undefined => {
  const h = out.json?.hookSpecificOutput as Record<string, unknown> | undefined;
  return h?.permissionDecision === 'deny' ? String(h.permissionDecisionReason) : undefined;
};
/** Отказ верхнего уровня (Gemini, Goose): причина или undefined. */
const blocked = (out: Out): string | undefined =>
  out.json?.decision === 'block' ? String(out.json.reason) : undefined;

type Mod = {
  cliOf: (i: unknown) => string;
  normalize: (i: unknown) => Array<Record<string, unknown>>;
  backgroundParam: (i: unknown) => string | null;
  hasShellTimeout: (i: unknown) => boolean;
};
const lib = async (): Promise<Mod> =>
  (await import(pathToFileURL(join(KIT, 'hooks', 'lib', 'kit-paths.mjs')).href)) as Mod;

describe('Gemini CLI: BeforeTool / AfterTool / BeforeAgent / AfterAgent', () => {
  const gemini = (session: string, extra: Record<string, unknown>) => ({
    session_id: session,
    cwd: PROJECT,
    transcript_path: '',
    timestamp: '2026-10-24T00:00:00Z',
    ...extra,
  });

  it('sed -i в run_shell_command — отказ {decision:block} с причиной охранника', () => {
    const payload = gemini('gm-sed', {
      hook_event_name: 'BeforeTool',
      tool_name: 'run_shell_command',
      tool_input: { command: SED },
    });
    const out = run('pre', payload, 'gemini');
    expect(blocked(out)).toMatch(/inline-edit-guard/);
    expect(out.json?.hookSpecificOutput).toBeUndefined();
    // Без --cli кит узнаёт Gemini по имени события.
    expect(blocked(run('pre', { ...payload, session_id: 'gm-sed2' }))).toMatch(/inline-edit-guard/);
  });

  it('разрешённый вызов — пустой stdout: у BeforeTool нет поля для текста', () => {
    const out = run(
      'pre',
      gemini('gm-docker', {
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'docker run --rm alpine true' },
      }),
      'gemini',
    );
    expect(out.raw).toBe('');
  });

  it('AfterAgent: правка кода без проверки — повтор хода с причиной; после vitest — тишина', () => {
    const s = 'gm-stop';
    run('prompt', gemini(s, { hook_event_name: 'BeforeAgent', prompt: 'поправь a.ts' }), 'gemini');
    const write = run(
      'pre',
      gemini(s, {
        hook_event_name: 'BeforeTool',
        tool_name: 'write_file',
        tool_input: { file_path: `${PROJECT}/src/a.ts`, content: 'export const a = 2;\n' },
      }),
      'gemini',
    );
    expect(write.raw).toBe('');
    const stop = () =>
      run(
        'stop',
        gemini(s, {
          hook_event_name: 'AfterAgent',
          prompt_response: 'Done.',
          stop_hook_active: false,
        }),
        'gemini',
      );
    expect(blocked(stop())).toMatch(/verify-at-stop: this turn edited 1 code file \(a\.ts\)/);
    run(
      'pre',
      gemini(s, {
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'npx vitest run src/a.test.ts' },
      }),
      'gemini',
    );
    expect(stop().raw).toBe('');
  });

  it('is_background — флаг фона Gemini; таймаута у его shell нет', async () => {
    const { backgroundParam, hasShellTimeout, cliOf } = await lib();
    const input = { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' };
    expect(cliOf(input)).toBe('gemini');
    expect(backgroundParam(input)).toBe('is_background');
    expect(hasShellTimeout(input)).toBe(false);
  });
});

describe('Goose: Open Plugins hooks', () => {
  const goose = (session: string, extra: Record<string, unknown>) => ({
    session_id: session,
    ...extra,
  });

  it('shell с sed -i — {decision:block}; рабочий каталог из working_dir', () => {
    const payload = goose('gs-sed', {
      event: 'PreToolUse',
      matcher_context: 'shell',
      tool_name: 'shell',
      tool_input: { command: SED },
      working_dir: PROJECT,
      tool_call_id: 'c1',
    });
    expect(blocked(run('pre', payload, 'goose'))).toMatch(/inline-edit-guard/);
    // Без --cli: поле `event` вместо hook_event_name — это Goose.
    expect(blocked(run('pre', { ...payload, session_id: 'gs-sed2' }))).toMatch(/inline-edit-guard/);
  });

  it('write {path, content} — это Write: агентский документ вне .agent/ отклонён', () => {
    const out = run(
      'pre',
      goose('gs-write', {
        event: 'PreToolUse',
        tool_name: 'write',
        tool_input: { path: join(repo, 'notes.agent.md'), content: '# notes\n' },
        working_dir: repo,
      }),
      'goose',
    );
    expect(blocked(out)).toMatch(/notes\.agent\.md is a new agent doc/);
  });

  it('разрешённый вызов и подсказки — пустой stdout: иное Goose счёл бы сбоем хука', () => {
    const allowed = run(
      'pre',
      goose('gs-docker', {
        event: 'PreToolUse',
        tool_name: 'shell',
        tool_input: { command: 'docker run --rm alpine true' },
        working_dir: PROJECT,
      }),
      'goose',
    );
    expect(allowed.raw).toBe('');
    const prompt = run(
      'prompt',
      goose('gs-docker', {
        event: 'UserPromptSubmit',
        message: 'посмотри фигму figma.com/design/x',
      }),
      'goose',
    );
    expect(prompt.raw).toBe('');
  });

  it('Stop: правка кода без проверки — {decision:block}; повторная проверка снимает', () => {
    const s = 'gs-stop';
    run('prompt', goose(s, { event: 'UserPromptSubmit', message: 'поправь a.ts' }), 'goose');
    run(
      'pre',
      goose(s, {
        event: 'PreToolUse',
        tool_name: 'edit',
        tool_input: { path: `${PROJECT}/src/a.ts`, before: 'a = 1', after: 'a = 2' },
        working_dir: PROJECT,
      }),
      'goose',
    );
    const stop = () =>
      run('stop', goose(s, { event: 'Stop', last_assistant_message: 'Done.' }), 'goose');
    expect(blocked(stop())).toMatch(/verify-at-stop: this turn edited 1 code file \(a\.ts\)/);
    run(
      'pre',
      goose(s, {
        event: 'PreToolUse',
        tool_name: 'shell',
        tool_input: { command: 'pnpm test' },
        working_dir: PROJECT,
      }),
      'goose',
    );
    expect(stop().raw).toBe('');
  });

  it('edit {before, after} и timeout_secs переводятся в поля Claude; фона у shell нет', async () => {
    const { normalize, backgroundParam, hasShellTimeout } = await lib();
    const [edit] = normalize({
      event: 'PreToolUse',
      tool_name: 'edit',
      tool_input: { path: 'src/a.ts', before: 'x', after: 'y' },
      working_dir: PROJECT,
    });
    expect(edit).toMatchObject({
      tool_name: 'Edit',
      hook_event_name: 'PreToolUse',
      cwd: PROJECT,
      tool_input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
    });
    const shell = { event: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'x' } };
    const call = normalize({ ...shell, tool_input: { command: 'x', timeout_secs: 90 } })[0]!;
    expect((call.tool_input as Record<string, unknown>).timeout).toBe(90_000);
    expect(backgroundParam(shell)).toBeNull();
    expect(hasShellTimeout(shell)).toBe(false);
  });
});

describe('Kimi Code: [[hooks]] PreToolUse / Stop', () => {
  const kimi = (session: string, extra: Record<string, unknown>) => ({
    session_id: session,
    cwd: PROJECT,
    ...extra,
  });

  it('Shell с sed -i — отказ формой permissionDecision deny (её Kimi и читает)', () => {
    const payload = kimi('km-sed', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Shell',
      tool_input: { command: SED, timeout: 60 },
      tool_call_id: 'k1',
    });
    expect(denied(run('pre', payload, 'kimi'))).toMatch(/inline-edit-guard/);
    // Без --cli: имя Shell есть только у Kimi.
    expect(denied(run('pre', { ...payload, session_id: 'km-sed2' }))).toMatch(/inline-edit-guard/);
  });

  it('«спросить» у Kimi не блокирует — становится отказом с просьбой спросить в чате', () => {
    const out = run(
      'pre',
      kimi('km-agent', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'helper', prompt: SPAWN, subagent_type: 'coder' },
      }),
      'kimi',
    );
    expect(denied(out)).toMatch(/^Needs the user's yes first/);
  });

  it('Stop — отказ формой deny: верхний decision Kimi пропускает мимо', () => {
    const s = 'km-stop';
    run('prompt', kimi(s, { hook_event_name: 'UserPromptSubmit', prompt: 'поправь a.ts' }), 'kimi');
    run(
      'pre',
      kimi(s, {
        hook_event_name: 'PreToolUse',
        tool_name: 'StrReplaceFile',
        tool_input: { path: `${PROJECT}/src/a.ts`, edit: { old: 'a = 1', new: 'a = 2' } },
      }),
      'kimi',
    );
    const out = run('stop', kimi(s, { hook_event_name: 'Stop', stop_hook_active: false }), 'kimi');
    expect(out.json?.decision).toBeUndefined();
    expect(denied(out)).toMatch(/verify-at-stop: this turn edited 1 code file \(a\.ts\)/);
    expect((out.json?.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe('Stop');
    // Повторный Stop после нашего же отказа — пропуск.
    expect(
      run('stop', kimi(s, { hook_event_name: 'Stop', stop_hook_active: true }), 'kimi').raw,
    ).toBe('');
  });

  it('StrReplaceFile со списком правок и Shell timeout в секундах — поля Claude', async () => {
    const { normalize, backgroundParam, hasShellTimeout } = await lib();
    const [edit] = normalize({
      hook_event_name: 'PreToolUse',
      tool_name: 'StrReplaceFile',
      tool_input: {
        path: 'src/a.ts',
        edit: [
          { old: 'a', new: 'b' },
          { old: 'c', new: 'd' },
        ],
      },
    });
    expect(edit).toMatchObject({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts', old_string: 'a\nc', new_string: 'b\nd' },
    });
    const shell = { hook_event_name: 'PreToolUse', tool_name: 'Shell', tool_input: {} };
    const call = normalize({ ...shell, tool_input: { command: 'x', timeout: 300 } })[0]!;
    expect((call.tool_input as Record<string, unknown>).timeout).toBe(300_000);
    expect(backgroundParam(shell)).toBe('run_in_background');
    expect(hasShellTimeout(shell)).toBe(false);
  });
});

describe('OpenCode: прослойка плагина зовёт диспетчер с --cli=opencode', () => {
  const oc = (session: string, tool: string, args: Record<string, unknown>) => ({
    hook_event_name: 'PreToolUse',
    session_id: session,
    cwd: PROJECT,
    tool_name: tool,
    tool_input: args,
    tool_use_id: `call-${session}`,
  });

  it('bash с sed -i — отказ Claude-формы; плагин бросает с этой причиной', () => {
    expect(denied(run('pre', oc('oc-sed', 'bash', { command: SED }), 'opencode'))).toMatch(
      /inline-edit-guard/,
    );
  });

  it('task (субагент) — «спросить» становится отказом', () => {
    const out = run(
      'pre',
      oc('oc-task', 'task', { description: 'helper', prompt: SPAWN, subagent_type: 'general' }),
      'opencode',
    );
    expect(denied(out)).toMatch(/^Needs the user's yes first/);
  });

  it('apply_patch (patchText) и edit (filePath, oldString) — вызовы Write/Edit', async () => {
    process.env.AGENTDECK_KIT_CLI = 'opencode';
    try {
      const { normalize, hasShellTimeout, backgroundParam } = await lib();
      const calls = normalize({
        tool_name: 'apply_patch',
        tool_input: {
          patchText: [
            '*** Begin Patch',
            '*** Add File: src/n.ts',
            '+export {};',
            '*** Update File: src/a.ts',
            '-a',
            '+b',
            '*** End Patch',
          ].join('\n'),
        },
      });
      expect(calls.map((c) => c.tool_name)).toEqual(['Write', 'Edit']);
      const [edit] = normalize({
        tool_name: 'edit',
        tool_input: { filePath: 'src/a.ts', oldString: 'a', newString: 'b' },
      });
      expect(edit).toMatchObject({
        tool_name: 'Edit',
        tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      });
      expect(hasShellTimeout({ tool_name: 'bash' })).toBe(true);
      expect(backgroundParam({ tool_name: 'bash' })).toBeNull();
    } finally {
      delete process.env.AGENTDECK_KIT_CLI;
    }
  });
});

describe('опознание CLI не трогает Claude, Qwen и Codex', () => {
  it('их входы узнаются как раньше', async () => {
    const { cliOf } = await lib();
    expect(cliOf({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBe('claude');
    expect(cliOf({ hook_event_name: 'PreToolUse', tool_name: 'Glob' })).toBe('claude');
    expect(cliOf({ hook_event_name: 'PreToolUse', tool_name: 'run_shell_command' })).toBe('qwen');
    expect(cliOf({ hook_event_name: 'PreToolUse', tool_name: 'Bash', turn_id: 't' })).toBe('codex');
    // Имя инструмента, совпавшее со свойством Object, не находит «перевода» в таблице.
    const odd = { tool_name: 'constructor', event: 'PreToolUse', tool_input: {} };
    expect(cliOf(odd)).toBe('goose');
    expect((await lib()).normalize(odd)[0]!.tool_name).toBe('constructor');
  });
});
