import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Аудит g9 27.10 (R5): стадия доставки опубликовала описание MR (~10 тыс. знаков) в 02:28,
 * прогнала проверку доставки, опубликовала его снова в 02:32, закончила ход, получила круг
 * панели и опубликовала в третий раз в 02:38 — каждая правка видна только после публикации.
 * Страж `mr-description-gate`: первая публикация свободна (бриф: «опубликуй один раз, потом
 * delivery»), повторная — только после проверки доставки, прошедшей после прошлой публикации
 * и после последнего сообщения панели. Запуск — через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-g9-mrdesc-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MR_TOOL = 'mcp__gitlab__update_merge_request';
const PASSED = 'Delivery: nothing left before the answer.';
const DELIVERY =
  'node "C:/panel/tools/tests-cli.mjs" delivery --project . --answer .agent/tmp/sieves.md --mr-description .agent/tmp/mr.md';

let n = 0;
const at = (minute: number) => `2026-10-27T02:${String(minute).padStart(2, '0')}:00.000Z`;
const say = (text: string, minute = 0) => ({
  type: 'user',
  timestamp: at(minute),
  message: { role: 'user', content: text },
});
const use = (name: string, input: object, id: string, minute = 1) => ({
  type: 'assistant',
  timestamp: at(minute),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false, minute = 1) => ({
  type: 'user',
  timestamp: at(minute),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});
const desc = (text: string) => ({ project_id: '1', merge_request_iid: '7', description: text });
const posted = (id: string, text = 'Первое описание', minute = 28) => [
  use(MR_TOOL, desc(text), id, minute),
  result(id, '{"iid":7}', false, minute),
];
const delivery = (id: string, body: string, isError = false, minute = 30) => [
  use('Bash', { command: DELIVERY }, id, minute),
  result(id, body, isError, minute),
];

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

const GROUP = { AGENTDECK_GROUP_STAGE: 'deliver' };

function pre(
  tool: string,
  toolInput: object,
  records: object[],
  env: NodeJS.ProcessEnv = GROUP,
): { decision?: string; reason: string } {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: `u${++n}`,
      cwd: dir,
      transcript_path: transcript(records),
      session_id: `g9-mrdesc-${n}`,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_GROUP_STAGE: '',
      AGENTDECK_SPLIT_CHILD: '',
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  const p = out
    ? ((
        JSON.parse(out) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      ).hookSpecificOutput ?? {})
    : {};
  return { decision: p.permissionDecision, reason: p.permissionDecisionReason ?? '' };
}

const gated = (v: { decision?: string; reason: string }) =>
  v.decision === 'deny' && v.reason.includes('mr-description-gate');

describe('mr-description-gate: повторная публикация описания MR ждёт прошедшей проверки доставки', () => {
  const start = say('Стадия доставки: открой MR.');

  it('первая публикация свободна — бриф велит опубликовать один раз и проверить живое MR', () => {
    expect(pre(MR_TOOL, desc('Описание'), [start]).decision).toBeUndefined();
  });

  it('повтор без проверки после первой публикации — отказ с временем публикации и рецептом черновика', () => {
    const v = pre(MR_TOOL, desc('Второе описание'), [start, ...posted('p1')]);
    expect(gated(v)).toBe(true);
    expect(v.reason).toContain(new Date(at(28)).toTimeString().slice(0, 5));
    expect(v.reason).toContain('--mr-description <that file>');
    expect(v.reason).toContain(PASSED);
  });

  it('повтор после проверки, напечатавшей «nothing left», проходит', () => {
    const records = [start, ...posted('p1'), ...delivery('d1', `ok\n${PASSED}`)];
    expect(pre(MR_TOOL, desc('Второе описание'), records).decision).toBeUndefined();
  });

  it('проверка с пробелами или запущенная в фоне — не подтверждение', () => {
    const red = [start, ...posted('p1'), ...delivery('d1', 'Exit code 1\n- sieve gap', true)];
    const v = pre(MR_TOOL, desc('Второе описание'), red);
    expect(gated(v)).toBe(true);
    expect(v.reason).toContain('still lists gaps');
    const bg = [
      start,
      ...posted('p1'),
      ...delivery('d2', 'Command running in background with ID: b1'),
    ];
    expect(gated(pre(MR_TOOL, desc('Второе описание'), bg))).toBe(true);
  });

  it('сообщение панели после прошедшей проверки требует новой проверки', () => {
    const records = [
      start,
      ...posted('p1'),
      ...delivery('d1', PASSED),
      say('The panel checked the group delivery — it is not finished.', 35),
    ];
    expect(gated(pre(MR_TOOL, desc('Третье описание'), records))).toBe(true);
  });

  it('прошедшая проверка ДО последней публикации не открывает следующую', () => {
    const records = [
      start,
      ...posted('p1'),
      ...delivery('d1', PASSED),
      ...posted('p2', 'Второе описание', 32),
    ];
    expect(gated(pre(MR_TOOL, desc('Третье описание'), records))).toBe(true);
  });

  it('публикация, которую отбил хук, публикацией не считается', () => {
    const records = [
      start,
      use(MR_TOOL, desc('Описание'), 'p0', 27),
      result(
        'p0',
        'PreToolUse:mcp__gitlab__update_merge_request hook error: rule-card: …',
        true,
        27,
      ),
    ];
    expect(pre(MR_TOOL, desc('Описание'), records).decision).toBeUndefined();
  });

  it('правка MR без описания (метки, черновик) не судится', () => {
    const records = [start, ...posted('p1')];
    expect(
      pre(MR_TOOL, { project_id: '1', merge_request_iid: '7', labels: 'ready' }, records).decision,
    ).toBeUndefined();
  });

  it('формы glab и gh: описание и тело — судятся, флаг в кавычках и --ready — нет', () => {
    const records = [start, ...posted('p1')];
    const bash = (command: string) => pre('Bash', { command }, records);
    expect(gated(bash('glab mr update 7 -d "новое описание"'))).toBe(true);
    expect(gated(bash('glab mr update 7 --description "$(cat .agent/tmp/mr.md)"'))).toBe(true);
    expect(gated(bash('gh pr edit 7 --body-file .agent/tmp/mr.md'))).toBe(true);
    expect(gated(bash('glab mr update 7 --ready'))).toBe(false);
    expect(gated(bash('echo "next: glab mr update 7 -d x"'))).toBe(false);
  });

  it('тот же вызов, повторённый после отказа стража, проходит', () => {
    const second = desc('Второе описание');
    const records = [
      start,
      ...posted('p1'),
      use(MR_TOOL, second, 'p2', 33),
      result(
        'p2',
        `PreToolUse:${MR_TOOL} hook error: [ctx-guard] mr-description-gate: this MR description was already posted`,
        true,
        33,
      ),
    ];
    expect(pre(MR_TOOL, second, records).decision).toBeUndefined();
    expect(gated(pre(MR_TOOL, desc('Другое описание'), records))).toBe(true);
  });

  it('вне группы панели страж молчит', () => {
    const records = [start, ...posted('p1')];
    expect(pre(MR_TOOL, desc('Второе описание'), records, {}).decision).toBeUndefined();
  });
});
