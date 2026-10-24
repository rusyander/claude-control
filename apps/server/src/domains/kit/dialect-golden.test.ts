import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Ответ кита Claude Code и Codex — байт в байт как до диалектов других CLI. Набор входов
 * прогоняется через тот же диспетчер, что зовёт hooks.json, и сверяется с записанным слепком
 * (`dialect-golden.fixture.json`, снят до правки диалектов). Слепок переснимается только
 * сознательно: `KIT_GOLDEN_WRITE=1`, и такое изменение — уже поведение Claude или Codex.
 * `KIT_UNDER_TEST=<каталог кита>` гоняет тот же набор по другой копии кита (слепок снят с кита
 * коммита до диалектов: `git archive HEAD apps/server/assets/kit`).
 */

const KIT = resolve(process.env.KIT_UNDER_TEST || builtinKitDir());
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const FIXTURE = fileURLToPath(new URL('./dialect-golden.fixture.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kit-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const repo = join(dir, 'repo');
/** Проект вне временного каталога: охранники пропускают пути во временных папках. */
const PROJECT = 'C:/work/proj';
mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');

let n = 0;
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (text: string, tools: object[] = []) => ({
  type: 'assistant',
  message: {
    id: `m${++n}`,
    role: 'assistant',
    content: [...tools, { type: 'text', text }],
  },
});
const edit = (file: string) => ({
  type: 'tool_use',
  id: `e${++n}`,
  name: 'Edit',
  input: { file_path: file, old_string: 'a', new_string: 'b' },
});

const SPAWN_PROMPT = 'Do X. [return-format] deliverable to .agent/tmp/x.md [no-subagents]';

type Case = { name: string; event: string; payload: () => Record<string, unknown> };

const base = (session: string, extra: Record<string, unknown>) => ({
  session_id: session,
  cwd: repo,
  transcript_path: transcript([prompt('поправь a')]),
  ...extra,
});

const CASES: Case[] = [
  {
    name: 'claude: sed -i → inline-edit-guard',
    event: 'pre',
    payload: () =>
      base('g-claude-sed', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: `sed -i 's/a/b/' src/x.ts` },
        cwd: PROJECT,
      }),
  },
  {
    name: 'claude: git push → git-guard',
    event: 'pre',
    payload: () =>
      base('g-claude-push', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      }),
  },
  {
    name: 'claude: pnpm lint → check-cost',
    event: 'pre',
    payload: () =>
      base('g-claude-lint', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm lint' },
      }),
  },
  {
    name: 'claude: Write of an agent doc',
    event: 'pre',
    payload: () =>
      base('g-claude-write', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(repo, 'notes.agent.md'), content: '# notes\n' },
      }),
  },
  {
    name: 'claude: Read → silence or rules',
    event: 'pre',
    payload: () =>
      base('g-claude-read', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: join(repo, 'a.ts') },
      }),
  },
  {
    name: 'claude: docker run → situational rule as context',
    event: 'pre',
    payload: () =>
      base('g-claude-docker', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'docker run --rm alpine true' },
        cwd: PROJECT,
      }),
  },
  {
    name: 'claude: Agent spawn → spawn-cost-guard',
    event: 'pre',
    payload: () =>
      base('g-claude-agent', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'helper', prompt: SPAWN_PROMPT },
      }),
  },
  {
    name: 'claude: post-any Bash',
    event: 'post-any',
    payload: () =>
      base('g-claude-post', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: { stdout: 'ok' },
      }),
  },
  {
    name: 'claude: stop after an edit with no check',
    event: 'stop',
    payload: () => ({
      hook_event_name: 'Stop',
      session_id: 'g-claude-stop',
      cwd: repo,
      transcript_path: transcript([
        prompt('поправь a'),
        said('Готово, поправил.', [edit(`${PROJECT}/src/a.ts`)]),
      ]),
    }),
  },
  {
    name: 'codex: sed -i → inline-edit-guard',
    event: 'pre',
    payload: () =>
      base('g-codex-sed', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: `sed -i 's/a/b/' src/x.ts` },
        cwd: PROJECT,
        turn_id: 't1',
      }),
  },
  {
    name: 'codex: git push → git-guard',
    event: 'pre',
    payload: () =>
      base('g-codex-push', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        turn_id: 't1',
      }),
  },
  {
    name: 'codex: apply_patch over two files',
    event: 'pre',
    payload: () =>
      base('g-codex-patch', {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: [
            '*** Begin Patch',
            `*** Add File: ${join(repo, 'notes.agent.md')}`,
            '+# notes',
            `*** Update File: ${join(repo, 'a.ts')}`,
            '-export const a = 1;',
            '+export const a = 2;',
            '*** End Patch',
          ].join('\n'),
        },
        turn_id: 't1',
      }),
  },
  {
    name: 'codex: spawn → ask turned deny',
    event: 'pre',
    payload: () =>
      base('g-codex-agent', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'helper', prompt: SPAWN_PROMPT },
        turn_id: 't1',
      }),
  },
  {
    name: 'codex: post-any Bash',
    event: 'post-any',
    payload: () =>
      base('g-codex-post', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: 'ok',
        turn_id: 't1',
      }),
  },
  {
    name: 'codex: docker run → situational rule as context',
    event: 'pre',
    payload: () =>
      base('g-codex-docker', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'docker run --rm alpine true' },
        cwd: PROJECT,
        turn_id: 't1',
      }),
  },
  {
    name: 'qwen: sed -i → inline-edit-guard',
    event: 'pre',
    payload: () =>
      base('g-qwen-sed', {
        hook_event_name: 'PreToolUse',
        tool_name: 'run_shell_command',
        tool_input: { command: `sed -i 's/a/b/' src/x.ts` },
        cwd: PROJECT,
      }),
  },
  {
    name: 'codex: stop',
    event: 'stop',
    payload: () => ({
      hook_event_name: 'Stop',
      session_id: 'g-codex-stop',
      cwd: repo,
      turn_id: 't1',
      transcript_path: transcript([
        prompt('поправь a'),
        said('Готово, поправил.', [edit(`${PROJECT}/src/a.ts`)]),
      ]),
    }),
  },
];

/** Пути копии кита, временного каталога и номера файлов не часть ответа кита — их выравниваем. */
function scrub(text: string): string {
  const forms = (path: string) => [
    path,
    path.split('\\').join('/'),
    JSON.stringify(path).slice(1, -1),
  ];
  let out = text;
  for (const form of forms(KIT)) out = out.split(form).join('<KIT>');
  for (const form of forms(dir)) out = out.split(form).join('<TMP>');
  return out.replace(/t\d+\.jsonl/g, 't#.jsonl');
}

function runAll(): Record<string, string> {
  const state = join(dir, 'state');
  rmSync(state, { recursive: true, force: true });
  const out: Record<string, string> = {};
  for (const c of CASES) {
    const res = spawnSync(process.execPath, [DISPATCH, c.event], {
      input: JSON.stringify(c.payload()),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_KIT_CLI: '',
        AGENTDECK_HEAVY_QUEUE_DIR: '',
        AGENTDECK_KIT_STATE: state,
      },
      timeout: 20_000,
    });
    out[c.name] = scrub(res.stdout);
  }
  return out;
}

describe('кит: Claude Code и Codex отвечают как до диалектов других CLI', () => {
  it('каждый вход — тот же ответ байт в байт', () => {
    const now = runAll();
    if (process.env.KIT_GOLDEN_WRITE === '1')
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`, 'utf8');
    expect(existsSync(FIXTURE), 'слепок не записан: KIT_GOLDEN_WRITE=1').toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    expect(Object.keys(now)).toEqual(Object.keys(golden));
    for (const name of Object.keys(golden)) expect(now[name], name).toBe(golden[name]);
    // Слепок, где всё пусто, ничего бы не держал: отказы и вопрос в нём есть.
    expect(golden['claude: sed -i → inline-edit-guard']).toMatch(/inline-edit-guard/);
    expect(golden['claude: Agent spawn → spawn-cost-guard']).toMatch(/"permissionDecision":"ask"/);
    expect(golden['codex: spawn → ask turned deny']).toMatch(/Needs the user's yes first/);
    expect(golden['claude: stop after an edit with no check']).toMatch(/verify-at-stop/);
  });
});
