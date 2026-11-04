import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function run(event: string, payload: object, cli?: string, env: Record<string, string> = {}): Out {
  const res = spawnSync(process.execPath, [DISPATCH, event, ...(cli ? [`--cli=${cli}`] : [])], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_CLI: '',
      AGENTDECK_STEP_KIND: '',
      AGENTDECK_KIT_STATE: STATE,
      ...env,
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

/**
 * P-19 (25.10, группа #0): mustfail одного файла (`--files`, секунды) отказывался как «известный
 * долгий гейт, больше 10 мин». Совет cmd-duration у каждого диалекта — свой (фон Claude/Kimi
 * `run_in_background`, Qwen/Gemini `is_background`, у OpenCode фона нет — совет по таймауту), а
 * список известных гейтов один: `lib/cmd-duration.mjs`. Codex и Goose совета не получают вовсе
 * (ни флага фона, ни таймаута в мс) — сюда не входят.
 */
describe('cmd-duration по диалектам: mustfail --files — не известный долгий гейт (P-19)', () => {
  const WHOLE = 'node tools/mustfail.mjs --base HEAD --cmd "npx vitest run a.test.ts"';
  // Узкие формы: файлы с правкой, один плановый мутант, план мутантов нового теста.
  const NARROW = [
    'node tools/mustfail.mjs --base HEAD --files src/a.ts --cmd "npx vitest run a.test.ts"',
    'node tools/mustfail.mjs --mutate src/a.ts:12 --cmd "npx vitest run a.test.ts"',
    'node tools/mustfail.mjs --mutants plan.json --cmd "npx vitest run a.test.ts"',
  ];
  const DIALECTS: {
    cli: string;
    call: (session: string, command: string) => object;
    hint: RegExp;
  }[] = [
    {
      cli: 'claude',
      call: (session, command) => ({
        hook_event_name: 'PreToolUse',
        session_id: session,
        cwd: PROJECT,
        tool_name: 'Bash',
        tool_input: { command },
      }),
      hint: /run_in_background/,
    },
    {
      cli: 'qwen',
      call: (session, command) => ({
        hook_event_name: 'PreToolUse',
        session_id: session,
        cwd: PROJECT,
        tool_name: 'run_shell_command',
        tool_input: { command },
      }),
      hint: /is_background/,
    },
    {
      cli: 'gemini',
      call: (session, command) => ({
        hook_event_name: 'BeforeTool',
        session_id: session,
        cwd: PROJECT,
        transcript_path: '',
        tool_name: 'run_shell_command',
        tool_input: { command },
      }),
      hint: /is_background/,
    },
    {
      cli: 'kimi',
      call: (session, command) => ({
        hook_event_name: 'PreToolUse',
        session_id: session,
        cwd: PROJECT,
        tool_name: 'Shell',
        tool_input: { command, timeout: 60 },
        tool_call_id: `k-${session}`,
      }),
      hint: /run_in_background/,
    },
    {
      cli: 'opencode',
      call: (session, command) => ({
        hook_event_name: 'PreToolUse',
        session_id: session,
        cwd: PROJECT,
        tool_name: 'bash',
        tool_input: { command },
        tool_use_id: `call-${session}`,
      }),
      hint: /Pass timeout/,
    },
  ];

  for (const { cli, call, hint } of DIALECTS) {
    it(`${cli}: весь дифф — известный гейт с советом своего CLI, --files — тишина`, () => {
      const whole = run('pre', call(`p19-${cli}-whole`, WHOLE), cli).raw;
      expect(whole).toMatch(/cmd-duration: this command is a known long gate/);
      expect(whole).toMatch(hint);
      NARROW.forEach((command, index) => {
        expect(run('pre', call(`p19-${cli}-narrow-${index}`, command), cli).raw).not.toMatch(
          /cmd-duration/,
        );
      });
    });
  }
});

/**
 * P-21 (25.10, группа #5): `git merge-tree … --quiet` на git 2.55 отвечает кодом 0 на настоящий
 * конфликт — группа читала «конфликта нет» и теряла ходы. Отказ с верной командой живёт в одном
 * `lib/git-guard.mjs`; у каждого CLI свой вход оболочки и своя форма отказа, проверяется, что
 * каждый диалект набора доходит до него, а сверка без `--quiet` проходит.
 */
const shell =
  (tool: string, extra: Record<string, unknown> = {}) =>
  (s: string, c: string, cwd = PROJECT) => ({
    hook_event_name: 'PreToolUse',
    session_id: s,
    cwd,
    tool_name: tool,
    tool_input: { command: c },
    ...extra,
  });
/** Вызов оболочки в родной форме каждого CLI набора (P-21..P-23). */
const SHELLS: { cli: string; call: (s: string, c: string, cwd?: string) => object }[] = [
  { cli: 'claude', call: shell('Bash') },
  { cli: 'qwen', call: shell('run_shell_command') },
  {
    cli: 'gemini',
    call: (s, c, cwd) => ({
      ...shell('run_shell_command')(s, c, cwd),
      hook_event_name: 'BeforeTool',
    }),
  },
  { cli: 'kimi', call: (s, c, cwd) => ({ ...shell('Shell')(s, c, cwd), tool_call_id: `k-${s}` }) },
  {
    cli: 'opencode',
    call: (s, c, cwd) => ({ ...shell('bash')(s, c, cwd), tool_use_id: `call-${s}` }),
  },
  { cli: 'codex', call: (s, c, cwd) => ({ ...shell('Bash')(s, c, cwd), turn_id: `t-${s}` }) },
  {
    cli: 'goose',
    call: (s, c, cwd = PROJECT) => ({
      session_id: s,
      event: 'PreToolUse',
      matcher_context: 'shell',
      tool_name: 'shell',
      tool_input: { command: c },
      working_dir: cwd,
      tool_call_id: `g-${s}`,
    }),
  },
];
// Отказ Claude-формы (Claude, Qwen, Kimi, OpenCode, Codex) или верхнего уровня (Gemini, Goose).
const refusal = (out: Out) => denied(out) ?? blocked(out);

describe('git-guard по диалектам: merge-tree --quiet отклонён с верной командой (P-21)', () => {
  const QUIET = 'git merge-tree --write-tree --quiet origin/main HEAD';
  const RIGHT = 'git merge-tree --write-tree --name-only origin/main HEAD > .agent/tmp/mt.txt';

  for (const { cli, call } of SHELLS) {
    it(`${cli}: --quiet — отказ с --name-only, без --quiet — пропуск`, () => {
      const reason = refusal(run('pre', call(`p21-${cli}-quiet`, QUIET), cli));
      expect(reason).toMatch(/git-guard\(merge-tree\)/);
      expect(reason).toMatch(/--name-only/);
      expect(refusal(run('pre', call(`p21-${cli}-right`, RIGHT), cli))).toBeUndefined();
    });
  }
});

/**
 * P-22 (25.10, группа #5 #112): правка черновика python-heredoc'ом после `cd $S/…` отказывалась —
 * `$S` из той же команды не раскрывался, файл черновика читался файлом проекта. Судья один,
 * `lib/inline-edit-guard.mjs`; проверяется, что каждый диалект набора до него доходит.
 */
describe('inline-edit-guard по диалектам: cd $S/… раскрывает переменную той же команды (P-22)', () => {
  const py = `python - <<'EOF'\nopen('handlers.go','w').write('x')\nEOF`;
  const SCRATCH = `W=${PROJECT}; S=$W/.agent/tmp/r/scratch; cd $S/inst-auth; ${py}`;
  const SOURCE = `W=${PROJECT}; S=$W/src; cd $S; ${py}`;

  for (const { cli, call } of SHELLS) {
    it(`${cli}: черновик через $S — пропуск, src через $S — отказ`, () => {
      expect(refusal(run('pre', call(`p22-${cli}-scratch`, SCRATCH), cli))).toBeUndefined();
      expect(refusal(run('pre', call(`p22-${cli}-src`, SOURCE), cli))).toMatch(
        /inline code writing a file/,
      );
    });
  }
});

/**
 * P-20 (25.10): стенограмму чужого CLI кит не читает, и гейт, пропущенный китом на PreToolUse, а
 * потом отказанный (человеком, правилами самого CLI, чужим хуком), читался исполненным: следующий
 * гейт получал «nothing was edited since» — правки кит тоже не видел. Теперь исполнение подтверждает
 * `ran` из post-хука, правки считаются по журналу сессии кита.
 */
describe('gate-at-end у чужих CLI: запуск без post-хука не исполнен, правки — из журнала (P-20)', () => {
  const GATE = 'pnpm type-check && pnpm lint && pnpm test';
  type Shape = { cli: string; tool: string; bg?: string; goose?: boolean; extra?: object };
  const SHAPES: Shape[] = [
    { cli: 'qwen', tool: 'run_shell_command', bg: 'is_background' },
    { cli: 'codex', tool: 'Bash', extra: { turn_id: 't' } },
    { cli: 'opencode', tool: 'bash' },
    { cli: 'kimi', tool: 'Shell', bg: 'run_in_background' },
    { cli: 'goose', tool: 'shell', goose: true },
    { cli: 'gemini', tool: 'run_shell_command', bg: 'is_background' },
  ];
  const at = (s: Shape, session: string, event: 'PreToolUse' | 'PostToolUse', id: string) => {
    const tool_input = { command: GATE, ...(s.bg ? { [s.bg]: true } : {}) };
    return s.goose
      ? {
          session_id: session,
          event,
          tool_name: s.tool,
          tool_input,
          working_dir: PROJECT,
          tool_call_id: id,
        }
      : {
          // Gemini зовёт те же события BeforeTool/AfterTool.
          hook_event_name:
            s.cli === 'gemini' ? (event === 'PreToolUse' ? 'BeforeTool' : 'AfterTool') : event,
          session_id: session,
          cwd: PROJECT,
          tool_name: s.tool,
          tool_input,
          tool_use_id: id,
          ...s.extra,
        };
  };
  const gateDeny = (out: Out) => /gate-at-end/.test(refusal(out) ?? '');

  for (const s of SHAPES) {
    it(`${s.cli}: отказанный после кита гейт не считается, исполненный (post) — считается`, () => {
      const session = `p20-${s.cli}`;
      expect(gateDeny(run('pre', at(s, session, 'PreToolUse', 'g1'), s.cli))).toBe(false);
      // g1 так и не исполнен — post не пришёл; следующий гейт не «уже был».
      expect(gateDeny(run('pre', at(s, session, 'PreToolUse', 'g2'), s.cli))).toBe(false);
      run('post-any', at(s, session, 'PostToolUse', 'g2'), s.cli);
      // g2 исполнен, правок после него нет — отказ «nothing was edited since».
      expect(refusal(run('pre', at(s, session, 'PreToolUse', 'g3'), s.cli))).toMatch(
        /nothing was edited since the full gate/,
      );
    });
  }

  it('qwen: правка после исполненного гейта видна — отказ follow-up с числом правок', () => {
    const q = SHAPES[0]!;
    const session = 'p20-qwen-edit';
    expect(gateDeny(run('pre', at(q, session, 'PreToolUse', 'g1'), 'qwen'))).toBe(false);
    run('post-any', at(q, session, 'PostToolUse', 'g1'), 'qwen');
    const edit = {
      hook_event_name: 'PreToolUse',
      session_id: session,
      cwd: PROJECT,
      tool_name: 'replace',
      tool_input: { file_path: `${PROJECT}/src/a.ts`, old_string: 'a', new_string: 'b' },
    };
    expect(refusal(run('pre', edit, 'qwen'))).toBeUndefined();
    expect(refusal(run('pre', at(q, session, 'PreToolUse', 'g2'), 'qwen'))).toMatch(
      /already ran at .*1 edit\(s\) since/,
    );
  });
});

describe('post-хук оболочки у каждого варианта набора — источник `ran` (P-20)', () => {
  const read = (p: string) => readFileSync(join(KIT, '..', 'variants', p), 'utf8');
  type Entry = { matcher?: string; hooks: { command: string }[] };
  const postShell = (entries: Entry[] | undefined, tool: string) =>
    (entries ?? []).some(
      (e) =>
        new RegExp(e.matcher === '*' ? '.*' : (e.matcher ?? '.*')).test(tool) &&
        e.hooks.some((h) => /run\.mjs" post-any/.test(h.command)),
    );

  it('Qwen (hooks.json набора), Codex, Gemini, Goose: PostToolUse/AfterTool ловит оболочку', () => {
    const own = JSON.parse(readFileSync(join(KIT, 'hooks', 'hooks.json'), 'utf8'));
    expect(postShell(own.hooks.PostToolUse, 'run_shell_command')).toBe(true);
    const codex = JSON.parse(read('codex/hooks/hooks.codex.json'));
    expect(postShell(codex.hooks.PostToolUse, 'Bash')).toBe(true);
    const gemini = JSON.parse(read('gemini/hooks/hooks.json'));
    expect(postShell(gemini.hooks.AfterTool, 'run_shell_command')).toBe(true);
    const goose = JSON.parse(read('goose/hooks/hooks.json'));
    expect(postShell(goose.hooks.PostToolUse, 'shell')).toBe(true);
  });

  it('Kimi: [[hooks]] PostToolUse по Shell; OpenCode: tool.execute.after зовёт post-any', () => {
    const kimi = read('kimi/hooks.toml');
    expect(kimi).toMatch(/event = "PostToolUse"\nmatcher = "\^Shell\$"\ncommand = "[^\n]*post-any/);
    const opencode = read('opencode/plugins/agentdeck-kit.js');
    expect(opencode).toMatch(/'tool\.execute\.after'[\s\S]*?dispatch\('post-any'/);
  });
});

/**
 * P-29 (26.10, K B2): три правки судей гейта набора — `node --check` только разбирает файл (не гейт и не
 * долгий гейт cmd-duration), gate-run — гейт только словом команды (присваивание пути и `cat` — нет), а
 * переписанный вызов гейт-скрипта (`timeout 900`, env, `./`, кавычки, `cd <тот же каталог> &&`) — тот же
 * гейт. Судьи одни, `lib/gate-at-end.mjs` и `lib/cmd-duration.mjs`; у чужого CLI история гейтов — журнал
 * сессии набора (`ran` из post-хука, P-20), и проверяется, что каждый диалект доходит до тех же судей.
 */
describe('судьи гейта 26.10 по диалектам: node --check, gate-run словом команды, переписанный гейт (P-29)', () => {
  const RUNNER = 'C:/work/x/tools/gate-run.mjs';
  const RUN = `node ${RUNNER} --ticket PROJ-1 "lint=npm run lint"`;
  const NAMED = [`K=${RUNNER}`, `cat ${RUNNER}`, `node --check ${RUNNER} && echo syntax-ok`];
  const GATE = 'node scripts/check_frontend_tests.mjs > .agent/tmp/t1.log 2>&1';
  const reworded = (project: string) => [
    'timeout 900 node scripts/check_frontend_tests.mjs > .agent/tmp/t2.log 2>&1',
    'CI=1 FORCE_COLOR=0 node ./scripts/check_frontend_tests.mjs > .agent/tmp/t3.log 2>&1',
    `cd ${project} && node "scripts/check_frontend_tests.mjs" > .agent/tmp/t4.log 2>&1`,
    'cd inst-admin-ui && node ../scripts/check_frontend_tests.mjs > ../t5.log 2>&1',
  ];
  // `run`: поля запуска гейта — фон, где он есть; OpenCode фона не знает, ему — таймаут в 600 с.
  type Shape = { cli: string; tool: string; run: object; goose?: boolean; extra?: object };
  const SHAPES: Shape[] = [
    { cli: 'qwen', tool: 'run_shell_command', run: { is_background: true } },
    { cli: 'codex', tool: 'Bash', run: {}, extra: { turn_id: 't' } },
    { cli: 'opencode', tool: 'bash', run: { timeout: 600_000 } },
    { cli: 'kimi', tool: 'Shell', run: { run_in_background: true } },
    { cli: 'goose', tool: 'shell', run: {}, goose: true },
    { cli: 'gemini', tool: 'run_shell_command', run: { is_background: true } },
  ];
  /** Свой каталог на диалект: длительность, выученная cmd-duration у одного, не судит другой. */
  const projectOf = (s: Shape) => `C:/work/proj-p29-${s.cli}`;
  const at = (
    s: Shape,
    session: string,
    event: 'PreToolUse' | 'PostToolUse',
    id: string,
    command: string,
    extra: object,
  ) => {
    const tool_input = { command, ...extra };
    return s.goose
      ? {
          session_id: session,
          event,
          tool_name: s.tool,
          tool_input,
          working_dir: projectOf(s),
          tool_call_id: id,
        }
      : {
          hook_event_name:
            s.cli === 'gemini' ? (event === 'PreToolUse' ? 'BeforeTool' : 'AfterTool') : event,
          session_id: session,
          cwd: projectOf(s),
          tool_name: s.tool,
          tool_input,
          tool_use_id: id,
          ...s.extra,
        };
  };
  const NOTHING = /nothing was edited since the full gate/;

  for (const s of SHAPES) {
    it(`${s.cli}: названный runner и node --check — не гейт; запуск словом команды и переписанный гейт — тот же`, () => {
      const pre = (session: string, id: string, command: string, extra = s.run) =>
        run('pre', at(s, session, 'PreToolUse', id, command, extra), s.cli);
      const ran = (session: string, id: string, command: string, extra = s.run) =>
        run('post-any', at(s, session, 'PostToolUse', id, command, extra), s.cli);

      // Названные формы — простым вызовом, без фона и таймаута: будь они гейтом, долгим гейтом
      // cmd-duration или гейтом журнала, был бы отказ здесь или на повторе.
      const named = `p29-${s.cli}-named`;
      NAMED.forEach((command, i) => {
        const out = pre(named, `n${i}`, command, {});
        expect(refusal(out), command).toBeUndefined();
        expect(out.raw, command).not.toMatch(/cmd-duration/);
        ran(named, `n${i}`, command, {});
        expect(refusal(pre(named, `m${i}`, command, {})), command).toBeUndefined();
        ran(named, `m${i}`, command, {});
      });
      // Названные формы исполнены, но гейтом не записаны: первый запуск — первый.
      expect(refusal(pre(named, 'g1', RUN))).toBeUndefined();
      ran(named, 'g1', RUN);
      // gate-run словом команды — гейт: тот же запуск без правок — «nothing was edited since».
      expect(refusal(pre(named, 'g2', RUN))).toMatch(NOTHING);

      const reword = `p29-${s.cli}-reword`;
      expect(refusal(pre(reword, 'g1', GATE))).toBeUndefined();
      ran(reword, 'g1', GATE);
      reworded(projectOf(s)).forEach((command, i) => {
        expect(refusal(pre(reword, `r${i}`, command)), command).toMatch(NOTHING);
      });
    });
  }
});

/**
 * P-29, rule-injector (g9 review F3): после сжатия группе Claude окно правила приходит ТЕКСТОМ на
 * SessionStart:compact — отказа карточки и повторного чтения нет. Поколение вызовов набор брал из
 * стенограммы Claude; стенограмму Qwen и Codex он не читает, и у их групп первая правка после каждого
 * сжатия была отказом карточки. Теперь поколение — из журнала сессии набора (вызовы PreToolUse,
 * метки сжатия PreCompact). Вручную ставящиеся CLI (Gemini, Goose, Kimi, OpenCode) правил на PreToolUse не
 * получают вовсе (`isHandInstalled`) — отказа карточки, который надо было бы снять, у них нет.
 */
describe('rule-injector по диалектам: окно правила текстом после сжатия, отказа карточки нет (P-29)', () => {
  const RULE_FILE = join(KIT, 'skills', 'situational-rules', 'references', 'visible-fix-shots.md');
  const FULL = readFileSync(RULE_FILE, 'utf8')
    .trim()
    .split('<kit>')
    .join(KIT.split('\\').join('/'));
  // Копия вне временного каталога: правка во временном — черновик, правило о UI её не касается.
  const copy = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-p29-rules-'));
  mkdirSync(join(copy, '.git'), { recursive: true });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));
  const CHILD = { AGENTDECK_STEP_KIND: 'implement' };
  const UI = join(copy, 'inst-admin-ui/src/pages/users/CreateRolePage/index.tsx')
    .split('\\')
    .join('/');
  // Стенограмма в формате самого CLI: записей Claude в ней нет.
  const foreignTranscript = (cli: string) => {
    const path = join(dir, `p29-${cli}-transcript.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'user', message: { role: 'user', parts: [{ text: 'do' }] } })}\n`,
    );
    return path;
  };
  const DIALECTS: { cli: string; edit: (session: string, tp: string) => object }[] = [
    {
      cli: 'qwen',
      edit: (session, tp) => ({
        hook_event_name: 'PreToolUse',
        session_id: session,
        transcript_path: tp,
        cwd: copy,
        tool_name: 'replace',
        tool_input: { file_path: UI, old_string: 'a', new_string: 'b' },
      }),
    },
    {
      cli: 'codex',
      edit: (session, tp) => ({
        hook_event_name: 'PreToolUse',
        session_id: session,
        transcript_path: tp,
        cwd: copy,
        turn_id: `t-${session}`,
        tool_name: 'apply_patch',
        tool_input: {
          command: `*** Begin Patch\n*** Update File: ${UI}\n@@\n-a\n+b\n*** End Patch`,
        },
      }),
    },
  ];
  const ctxOf = (out: Out) =>
    String(
      (out.json?.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext ??
        '',
    );

  for (const { cli, edit } of DIALECTS) {
    it(`${cli}: правило целиком → сжатие → старт с текстом окна → правка проходит`, () => {
      const session = `p29-rules-${cli}`;
      const tp = foreignTranscript(cli);
      const first = run('pre', edit(session, tp), cli, CHILD);
      expect(refusal(first)).toBeUndefined();
      expect(ctxOf(first)).toContain(FULL);
      run(
        'precompact',
        { hook_event_name: 'PreCompact', session_id: session, transcript_path: tp, cwd: copy },
        cli,
        CHILD,
      );
      const start = run(
        'session',
        {
          hook_event_name: 'SessionStart',
          source: 'compact',
          session_id: session,
          transcript_path: tp,
          cwd: copy,
        },
        cli,
        CHILD,
      );
      expect(ctxOf(start)).toContain('rule text after compaction');
      expect(ctxOf(start)).toContain(FULL);
      const next = run('pre', edit(session, tp), cli, CHILD);
      expect(refusal(next)).toBeUndefined();
      // Текст уже в окне: правка не тянет правило второй раз.
      expect(ctxOf(next)).not.toContain(FULL);
    });
  }

  it('второе сжатие берёт только своё поколение: правки UI до первого сжатия окна не возвращают', () => {
    const session = 'twice-p29-qwen';
    const tp = foreignTranscript('qwen-twice');
    const q = DIALECTS[0]!;
    const base = { session_id: session, transcript_path: tp, cwd: copy };
    const compact = () => {
      run('precompact', { ...base, hook_event_name: 'PreCompact' }, 'qwen', CHILD);
      return ctxOf(
        run(
          'session',
          { ...base, hook_event_name: 'SessionStart', source: 'compact' },
          'qwen',
          CHILD,
        ),
      );
    };
    expect(ctxOf(run('pre', q.edit(session, tp), 'qwen', CHILD))).toContain(FULL);
    expect(compact()).toContain('rule text after compaction');
    // Второе поколение: только чтение состояния git, ни одной правки UI.
    run(
      'pre',
      {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git status' },
      },
      'qwen',
      CHILD,
    );
    // Метка первого сжатия отрезает его правку: этому поколению правило не было нужно.
    expect(compact()).not.toContain('after compaction');
  });

  it('без PreCompact штамп правила жив: на старте пересылать нечего, следующая правка не отказана', () => {
    const session = 'nomark-p29-qwen';
    const tp = foreignTranscript('qwen-nomark');
    const q = DIALECTS[0]!;
    expect(ctxOf(run('pre', q.edit(session, tp), 'qwen', CHILD))).toContain(FULL);
    // PreCompact не дошёл (событие не пришло): метки нет и штамп правила не снят.
    const start = run(
      'session',
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: session,
        transcript_path: tp,
        cwd: copy,
      },
      'qwen',
      CHILD,
    );
    // Штамп не снят — правило по-прежнему «в окне»: ни текста, ни карточки, ни отказа.
    expect(ctxOf(start)).not.toContain('after compaction');
    expect(refusal(run('pre', q.edit(session, tp), 'qwen', CHILD))).toBeUndefined();
  });
});

/**
 * P-31 (gor-1063 #90): гейт, которому отказала проверка движка Node (`npm error code EBADENGINE`, «Гейт рассчитан
 * на Node 22…, запущен на v24»), ни одной проверки не прогнал — это не прогон гейта, и повтор на нужном Node без
 * правок не «nothing was edited since». У Claude набор читает это из стенограммы; у чужого CLI — из того, что
 * видит его post-хук: тело ответа (под любым ключом диалекта — читатель обходит все поля, кроме входа вызова) и
 * хвосты логов перенаправления. Фоновый запуск отказа в теле ещё не несёт — его лог перечитывается на следующем
 * гейте. Судья один, `lib/gate-at-end.mjs`; `ran` с отметкой пишет диспетчер (`items.mjs`).
 */
describe('gate-at-end по диалектам: отказ движка Node — не прогон гейта (P-31)', () => {
  const GATE = 'pnpm type-check && pnpm lint && pnpm test';
  const REFUSED = 'npm error code EBADENGINE\nnpm error engine Unsupported engine';
  type Shape = { cli: string; tool: string; run: object; goose?: boolean; extra?: object };
  // `body` — поле ответа в форме диалекта; ключ читателю не важен, он обходит все.
  const SHAPES: (Shape & { body: (text: string) => object })[] = [
    {
      cli: 'qwen',
      tool: 'run_shell_command',
      run: { is_background: true },
      body: (t) => ({ tool_response: { llmContent: t, returnDisplay: t } }),
    },
    {
      cli: 'codex',
      tool: 'Bash',
      run: {},
      extra: { turn_id: 't' },
      body: (t) => ({ tool_response: t }),
    },
    {
      cli: 'opencode',
      tool: 'bash',
      run: { timeout: 600_000 },
      body: (t) => ({ tool_response: t }),
    },
    {
      cli: 'kimi',
      tool: 'Shell',
      run: { run_in_background: true },
      body: (t) => ({ tool_output: t }),
    },
    { cli: 'goose', tool: 'shell', run: {}, goose: true, body: (t) => ({ tool_response: t }) },
    {
      cli: 'gemini',
      tool: 'run_shell_command',
      run: { is_background: true },
      body: (t) => ({ tool_response: { llmContent: t, returnDisplay: t } }),
    },
  ];
  const projectOf = (s: Shape) => `C:/work/proj-p31-${s.cli}`;
  const at = (
    s: Shape,
    session: string,
    event: 'PreToolUse' | 'PostToolUse',
    id: string,
    command: string,
    more: object = {},
  ) => {
    const tool_input = { command, ...s.run };
    return s.goose
      ? {
          session_id: session,
          event,
          tool_name: s.tool,
          tool_input,
          working_dir: projectOf(s),
          tool_call_id: id,
          ...more,
        }
      : {
          hook_event_name:
            s.cli === 'gemini' ? (event === 'PreToolUse' ? 'BeforeTool' : 'AfterTool') : event,
          session_id: session,
          cwd: projectOf(s),
          tool_name: s.tool,
          tool_input,
          tool_use_id: id,
          ...s.extra,
          ...more,
        };
  };
  const NOTHING = /nothing was edited since the full gate/;

  for (const s of SHAPES) {
    it(`${s.cli}: отказ движка в теле ответа и в логе фона — не прогон; настоящий прогон — прогон`, () => {
      const pre = (session: string, id: string, command: string) =>
        run('pre', at(s, session, 'PreToolUse', id, command), s.cli);
      const ran = (session: string, id: string, command: string, text: string) =>
        run('post-any', at(s, session, 'PostToolUse', id, command, s.body(text)), s.cli);

      // Тело ответа: движок отказал — повтор без правок проходит.
      const body = `p31-${s.cli}-body`;
      expect(refusal(pre(body, 'g1', GATE))).toBeUndefined();
      ran(body, 'g1', GATE, REFUSED);
      expect(refusal(pre(body, 'g2', GATE))).toBeUndefined();
      // На нужном Node гейт прошёл — он и есть прогон: следующий без правок отказан.
      ran(body, 'g2', GATE, '✓ 412 tests passed');
      expect(refusal(pre(body, 'g3', GATE))).toMatch(NOTHING);

      // Лог перенаправления: тело фонового старта пустое, отказ движка лёг в лог позже.
      const log = join(dir, `p31-${s.cli}.log`).replace(/\\/g, '/');
      const logged = `${GATE} > ${log} 2>&1`;
      const bg = `p31-${s.cli}-log`;
      writeFileSync(log, '');
      expect(refusal(pre(bg, 'g1', logged))).toBeUndefined();
      ran(bg, 'g1', logged, 'Command started in background');
      writeFileSync(
        log,
        '> check\nГейт рассчитан на Node 22.x, запущен на v24.11.0 — переключите Node.\n',
      );
      expect(refusal(pre(bg, 'g2', logged))).toBeUndefined();
      // `>` обнуляет лог при старте оболочки — до post-хука фонового запуска.
      writeFileSync(log, '');
      ran(bg, 'g2', logged, 'Command started in background');
      writeFileSync(log, 'Tests  412 passed (412)\n');
      expect(refusal(pre(bg, 'g3', logged))).toMatch(NOTHING);
    });
  }
});
