import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Отказы и пропуски стражей, найденные наблюдением за группой g5 (25.10): ребёнок судится по своему
 * журналу (`verify-throttle`), длинный heredoc в файл — в Write/Edit (`inline-edit-guard`), соседний гейт и гейт,
 * прерванный концом сессии, — не повтор (`gate-at-end`). Запуск — через диспетчер событий, как его зовёт
 * hooks.json, со своим журналом во временном каталоге.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-watch-g5-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const say = (text: string) => ({
  type: 'user',
  timestamp: at(-120_000),
  message: { role: 'user', content: text },
});
const use = (name: string, input: object, id = `u${++n}`) => ({
  type: 'assistant',
  timestamp: at(-60_000),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false) => ({
  type: 'user',
  timestamp: at(-59_000),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});

const lines = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, lines(records), 'utf8');
  return path;
}

/** Причина отказа (пусто — отказа нет); правило-подсказка (additionalContext) отказом не считается. */
function pre(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: dir,
      ...payload,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      AGENTDECK_STEP_KIND: '',
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  const hook = out
    ? (JSON.parse(out) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
    : {};
  return hook.hookSpecificOutput?.permissionDecisionReason ?? '';
}

/** Журнал ребёнка там, где его кладёт CLI: `<журнал родителя>/subagents/agent-<id>.jsonl`. */
function childOf(parent: string, agent: string, records: object[]) {
  const own = join(parent.replace(/\.jsonl$/, ''), 'subagents', `agent-${agent}.jsonl`);
  mkdirSync(join(own, '..'), { recursive: true });
  writeFileSync(own, lines(records), 'utf8');
}

describe('verify-throttle: ребёнок судится по своему журналу', () => {
  // g5 25.10 K1: линия ревью перезапускала свой же зелёный `go test`, менялась только труба.
  const GO = 'cd /c/work/svc && go test ./internal/handlers/...';
  // Зелёный прогон есть и у родителя: судимый по чужому журналу ребёнок получил бы отказ.
  const parent = transcript([
    say('сделай'),
    use('Bash', { command: `${GO} 2>&1 | tail -20` }, 'v0'),
    result('v0', 'ok  svc/internal/handlers 1.1s'),
  ]);
  childOf(parent, 'lane1', [
    say('lane B'),
    use('Bash', { command: `${GO} 2>&1 | tail -20` }, 'v1'),
    result('v1', 'ok  svc/internal/handlers 1.2s'),
  ]);

  it('повтор своей зелёной проверки ребёнком без правок — отказ', () => {
    const reason = pre({
      tool_input: { command: `${GO} 2>&1 | head -40` },
      agent_id: 'lane1',
      transcript_path: parent,
    });
    expect(reason).toMatch(/this check already passed/);
  });

  it('ребёнок без своего файла журнала не судится по журналу родителя', () => {
    const reason = pre({
      tool_input: { command: `${GO} 2>&1 | head -40` },
      agent_id: 'nofile',
      transcript_path: parent,
    });
    expect(reason).not.toMatch(/this check already passed/);
  });
});

describe('inline-edit-guard: длинный heredoc в файл — в Write/Edit', () => {
  // g5 25.10 K3: 9.8 KB `cat >> lane-B.md <<'EOF'` в черновик дважды обрывался «unexpected EOF».
  const target = '/c/w/.agent/tmp/review/lane-B.md';
  const bash = (command: string) =>
    pre({ tool_input: { command }, transcript_path: transcript([say('сделай')]) });

  it('heredoc длиннее 6000 знаков в файл — отказ, даже в черновик', () => {
    const lane = `cat >> ${target} <<'EOF'\n${"| row | it's a cell |\n".repeat(400)}EOF`;
    expect(bash(lane)).toMatch(/inline-edit-guard: this heredoc command is \d+ chars/);
  });

  it('короткий heredoc в черновик и длинный heredoc-скрипт без записи файла проходят', () => {
    const short = `cat >> ${target} <<'EOF'\n${'| row |\n'.repeat(20)}EOF`;
    expect(bash(short)).not.toMatch(/inline-edit-guard/);
    const script = `node - <<'EOF' 2>&1\n${'console.log(1);\n'.repeat(500)}EOF`;
    expect(bash(script)).not.toMatch(/inline-edit-guard/);
  });
});

describe('gate-at-end: соседний гейт и прерванный гейт — не повтор', () => {
  const FE =
    'node scripts/check_frontend.mjs > .agent/tmp/gate-fe.log 2>&1; echo "fe exit=$?"; tail -15 .agent/tmp/gate-fe.log';
  const FET =
    'node scripts/check_frontend_tests.mjs --base origin/main > .agent/tmp/gate-fet.log 2>&1; echo "fet exit=$?"';
  const CUT =
    "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]";
  const gate = (command: string, records: object[]) =>
    pre({ tool_input: { command, run_in_background: true }, transcript_path: transcript(records) });

  it('после зелёного check_frontend впервые check_frontend_tests проходит, тот же гейт с другим tail — повтор', () => {
    // g5 25.10 deliver K1: соседний гейт трижды отклонён «с полного гейта ничего не правилось».
    const green = [
      say('сделай'),
      use('Bash', { command: FE }, 'gs1'),
      result('gs1', 'fe exit=0\nOK'),
    ];
    expect(gate(FET, green)).not.toMatch(/gate-at-end/);
    expect(gate(FE.replace('tail -15', 'tail -40'), green)).toMatch(/gate-at-end/);
  });

  it('гейт, прерванный концом сессии, — не итог: повтор проходит; красный без правок — отказ', () => {
    // g5 25.10 журнал #31: гейт, убитый концом сессии, после продолжения отклонялся как повтор.
    const cut = [
      say('сделай'),
      use('Bash', { command: FET, run_in_background: true }, 'gi1'),
      result('gi1', CUT, true),
      say('продолжай'),
    ];
    expect(gate(FET, cut)).not.toMatch(/gate-at-end/);
    const red = [
      say('сделай'),
      use('Bash', { command: FET }, 'gr1'),
      result('gr1', 'Exit code 1\n2 failed'),
      say('продолжай'),
    ];
    expect(gate(FET, red)).toMatch(/gate-at-end/);
  });
});
