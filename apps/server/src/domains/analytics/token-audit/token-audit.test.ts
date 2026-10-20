import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditClaudeFile,
  auditClaudeRows,
  auditForeignLines,
  checkLimits,
  findClaudeTranscript,
  foreignChatLogs,
  headline,
  parseTranscript,
  splitChats,
  splitSessionIds,
  stepClass,
  totalHeadline,
} from './token-audit.ts';
import { foreignToolUse } from './step-class.ts';
import { economyOf, wholeProjectCheck } from './economy.ts';
import { formatSession } from './report.ts';
import { appendMessage, createChat } from '../../provider-chat/store/store.ts';

/**
 * Измеритель расхода (этап 0 плана экономии). Образец — транскрипт в форме,
 * которую пишет Claude Code 2.1.x (сверено с расшифровками групп 16.10):
 * ответ модели — несколько записей с одним `message.id`, вложения до первого
 * ответа — постоянная часть. Числа подобраны так, чтобы двойной счёт или
 * потерянное слагаемое давали другое число.
 */

const TS = (minute: number): string => `2026-10-16T15:${String(minute).padStart(2, '0')}:00.000Z`;

function assistant(
  id: string,
  minute: number,
  usage: { input: number; read: number; write: number; out: number; write1h?: number },
  content: unknown[],
): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: TS(minute),
    message: {
      id,
      model: 'claude-opus-5-5',
      content,
      usage: {
        input_tokens: usage.input,
        cache_read_input_tokens: usage.read,
        cache_creation_input_tokens: usage.write,
        cache_creation: { ephemeral_1h_input_tokens: usage.write1h ?? usage.write },
        output_tokens: usage.out,
      },
    },
  };
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function result(id: string, content: unknown, isError = false): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
  };
}

const FILE = 'C:\\repo\\src\\feature\\thing.ts';
const BIG = 'x'.repeat(4000);

/** Сессия-образец: 6 вызовов, один из них записан двумя записями. */
function sampleRows(): Array<Record<string, unknown>> {
  return [
    {
      type: 'attachment',
      attachment: {
        type: 'instructions',
        files: [
          { path: 'C:\\Users\\u\\.claude\\CLAUDE.md', content: 'a'.repeat(1500) },
          { path: 'C:\\repo\\CLAUDE.local.md', content: 'b'.repeat(2900) },
        ],
      },
    },
    {
      type: 'attachment',
      attachment: { type: 'skill_listing', content: 's'.repeat(2200), skillCount: 68 },
    },
    {
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: [
          'WebFetch',
          'mcp__tracker__jira_get',
          'mcp__tracker__jira_put',
          'mcp__claude_ai_Gmail__send',
        ],
      },
    },
    {
      type: 'attachment',
      attachment: { type: 'mcp_instructions_delta', addedBlocks: ['m'.repeat(450)] },
    },
    {
      type: 'attachment',
      attachment: { type: 'agent_listing_delta', addedLines: ['l'.repeat(99), 'l'.repeat(99)] },
    },
    { type: 'user', timestamp: TS(0), message: { role: 'user', content: 'T'.repeat(3800) } },
    assistant('m1', 1, { input: 10, read: 0, write: 74_000, out: 100 }, [
      use('t1', 'Read', { file_path: FILE }),
    ]),
    // Тот же ответ второй записью: расход не должен удвоиться.
    assistant('m1', 1, { input: 10, read: 0, write: 74_000, out: 100 }, [
      { type: 'text', text: 'hello' },
    ]),
    result('t1', 'file body'),
    assistant('m2', 2, { input: 5, read: 74_000, write: 1_000, out: 50 }, [
      use('t2', 'Read', { file_path: FILE }),
    ]),
    result('t2', 'file body again'),
    assistant('m3', 3, { input: 5, read: 75_000, write: 2_000, out: 900 }, [
      use('t3', 'Write', { file_path: 'C:\\repo\\src\\new.ts', content: BIG }),
    ]),
    {
      type: 'attachment',
      attachment: {
        type: 'hook_additional_context',
        hookName: 'PreToolUse:Read',
        content: [
          '<persisted-output>\nOutput too large (29.1KB). Full output saved to: x\n</persisted-output>',
        ],
      },
    },
    result('t3', 'ok'),
    assistant('m4', 4, { input: 5, read: 77_000, write: 500, out: 40 }, [
      use('t4', 'Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }),
    ]),
    result('t4', 'edited'),
    assistant('m5', 5, { input: 5, read: 77_500, write: 500, out: 30 }, [
      use('t5', 'Bash', { command: `cat ${FILE.replace(/\\/g, '/')}` }),
    ]),
    result('t5', 'PreToolUse:Bash hook error: [ctx-guard] denied re-read of the same file', true),
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } },
    assistant('m6', 30, { input: 5, read: 10_000, write: 20_000, out: 60, write1h: 0 }, [
      use('t6', 'Bash', { command: 'pnpm type-check 2>&1 | tail -5' }),
    ]),
    result('t6', [
      { type: 'text', text: 'ok' },
      { type: 'image', source: { data: '' } },
    ]),
  ];
}

const lines = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

describe('token-audit — транскрипт Claude', () => {
  it('один ответ из нескольких записей считается одним вызовом, итоги — суммой вызовов', () => {
    const audit = auditClaudeRows('s1', sampleRows());
    expect(audit.calls).toBe(6);
    expect(audit.totals).toEqual({
      input: 35,
      cacheRead: 313_500,
      cacheWrite: 98_000,
      cacheWrite1h: 78_000,
      output: 1_180,
    });
    expect(audit.maxContext).toBe(77_505 + 500);
    expect(audit.averageContext).toBe(
      Math.round((74_010 + 75_005 + 77_005 + 77_505 + 78_005 + 30_005) / 6),
    );
    expect(audit.compactions).toBe(1);
  });

  it('постоянная часть — вложения до первого ответа: инструкции, навыки, отложенные инструменты, задание', () => {
    const c = auditClaudeRows('s1', sampleRows()).constant!;
    expect(c.firstContext).toBe(74_010);
    expect(c.taskChars).toBe(3_800);
    expect(c.instructions.map((f) => f.chars)).toEqual([1_500, 2_900]);
    expect([c.skillChars, c.skillCount]).toEqual([2_200, 68]);
    expect(c.deferredTools).toBe(4);
    expect(c.deferredBySource).toEqual({ builtin: 1, 'mcp:tracker': 2, 'mcp:claude_ai_Gmail': 1 });
    expect(c.mcpInstructionChars).toBe(450);
    expect(c.agentListingChars).toBe(200);
  });

  it('повтор без правки между просмотрами — потеря, просмотр после правки — нет', () => {
    const audit = auditClaudeRows('s1', sampleRows());
    // Read, Read (повтор без правки), Edit, cat (после правки — не потеря).
    expect(audit.rereads.files).toBe(1);
    expect(audit.rereads.top).toEqual([{ path: 'src/feature/thing.ts', views: 3 }]);
    expect(audit.rereads.unchanged).toBe(1);

    // Тот же кусок после правки — не потеря, без правки — потеря.
    const read = (id: string, minute: number) =>
      assistant(id, minute, { input: 1, read: 1, write: 1, out: 1 }, [
        use(`u-${id}`, 'Read', { file_path: FILE }),
      ]);
    const edit = assistant('e', 2, { input: 1, read: 1, write: 1, out: 1 }, [
      use('u-e', 'Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }),
    ]);
    expect(auditClaudeRows('r', [read('a', 1), edit, read('b', 3)]).rereads.unchanged).toBe(0);
    expect(auditClaudeRows('r', [read('a', 1), read('b', 3)]).rereads.unchanged).toBe(1);
  });

  it('хуки, отказы, выгрузки в файл, файлы целиком, картинки, всплески записи', () => {
    const audit = auditClaudeRows('s1', sampleRows());
    expect(Object.keys(audit.hookContext)).toEqual(['PreToolUse:Read']);
    expect(audit.spills).toBe(1);
    expect(audit.hookDenials).toEqual({ '[ctx-guard]': 1 });
    expect(audit.tools.Bash).toEqual({
      calls: 2,
      resultChars:
        'ok'.length +
        'PreToolUse:Bash hook error: [ctx-guard] denied re-read of the same file'.length,
      errors: 1,
    });
    expect(audit.outputChars.wholeFileWrites).toBe(1);
    expect(audit.outputChars.wholeFileChars).toBe(4_000);
    expect(audit.images).toBe(1);
    expect(audit.cacheWriteSpikes.map((s) => [s.write, s.causes.sort()])).toEqual([
      [74_000, ['start', 'user']],
      [20_000, ['cold', 'compact']],
    ]);
    expect(audit.steps).toMatchObject({
      read: { calls: 3 },
      edit: { calls: 2 },
      gate: { calls: 1 },
    });
    expect(audit.tinyBash.calls).toBe(2);
  });

  it('испорченная строка в середине — ошибка; недописанная последняя — нет; без ответов модели — ошибка', () => {
    const good = lines(sampleRows());
    const [first, ...rest] = good.split('\n');
    expect(() => parseTranscript([first, '{"type":"assis', ...rest].join('\n'))).toThrow(
      /испорченные строки 2/,
    );
    expect(parseTranscript(good + '{"type":"assist').length).toBe(sampleRows().length);
    expect(() => auditClaudeRows('x', [{ type: 'user', message: { content: 'hi' } }])).toThrow(
      /не транскрипт Claude Code/,
    );
  });
});

describe('token-audit — повторы и метрики плана экономии', () => {
  const tiny = { input: 1, read: 1, write: 1, out: 1 };
  const bash = (id: string, minute: number, command: string) =>
    assistant(id, minute, tiny, [use(`u-${id}`, 'Bash', { command })]);
  const readFile = (id: string, minute: number) =>
    assistant(id, minute, tiny, [use(`u-${id}`, 'Read', { file_path: FILE })]);
  const PATH = 'C:/repo/src/feature/thing.ts';
  const unchanged = (rows: Array<Record<string, unknown>>): number =>
    auditClaudeRows('r', rows).rereads.unchanged;

  it('запись через Bash, другой кусок, сжатие и смена дерева — не повтор без правки', () => {
    // Контроль: тот же `cat` дважды подряд — повтор.
    expect(unchanged([bash('a', 1, `cat ${PATH}`), bash('b', 2, `cat ${PATH}`)])).toBe(1);
    const python = `python -c "open('${PATH}','w').write('x')"`;
    expect(
      unchanged([bash('a', 1, `cat ${PATH}`), bash('w', 2, python), bash('b', 3, `cat ${PATH}`)]),
    ).toBe(0);
    expect(
      unchanged([
        bash('a', 1, `cat ${PATH}`),
        bash('w', 2, `sed -i 's/a/b/' ${PATH}`),
        bash('b', 3, `cat ${PATH}`),
      ]),
    ).toBe(0);
    expect(
      unchanged([
        bash('a', 1, `cat ${PATH}`),
        bash('g', 2, 'git checkout other'),
        bash('b', 3, `cat ${PATH}`),
      ]),
    ).toBe(0);
    // Соседние куски одного файла — разные, тот же кусок — повтор.
    expect(
      unchanged([bash('a', 1, `sed -n 1,40p ${PATH}`), bash('b', 2, `sed -n 41,80p ${PATH}`)]),
    ).toBe(0);
    expect(
      unchanged([bash('a', 1, `sed -n 1,40p ${PATH}`), bash('b', 2, `sed -n 1,40p ${PATH}`)]),
    ).toBe(1);
    // Сжатие стёрло прочитанное из окна: следующий просмотр честный.
    const compact = { type: 'user', isCompactSummary: true, message: { content: 'summary' } };
    expect(unchanged([readFile('a', 1), compact, readFile('b', 3)])).toBe(0);
    expect(unchanged([readFile('a', 1), readFile('b', 3)])).toBe(1);
  });

  it('проверка на весь проект — одна, без сужения и не гейт', () => {
    expect(wholeProjectCheck('npx vitest run 2>&1 | tail -5')).toBe(true);
    expect(wholeProjectCheck('pnpm lint')).toBe(true);
    // Суд тот же, что у check-cost: проверка одного пакета и список файлов в переменной — узкие.
    expect(wholeProjectCheck('cd apps/server && npx tsc --noEmit')).toBe(false);
    expect(wholeProjectCheck('npx tsc --noEmit -p packages/food')).toBe(false);
    expect(wholeProjectCheck('npx eslint $FILES')).toBe(false);
    expect(wholeProjectCheck('npx vitest run economy')).toBe(false);
    expect(wholeProjectCheck('npx vitest run src/domains/analytics/')).toBe(false);
    expect(wholeProjectCheck('npx eslint src/a.ts')).toBe(false);
    expect(wholeProjectCheck('npx tsc --noEmit --incremental')).toBe(false);
    expect(wholeProjectCheck('pnpm lint && pnpm test && pnpm type-check')).toBe(false);
    // Скрипт гейта плюс одна проверка — забота меры о гейте, не этой.
    expect(wholeProjectCheck('pnpm verify && npx vitest run')).toBe(false);
    expect(wholeProjectCheck('node tests/lint.test.mjs')).toBe(false);
    expect(wholeProjectCheck('git status')).toBe(false);
  });

  it('метрики: постоянная часть, одиночные шаги, проверки, таймауты, sleep, правила на черновиках', () => {
    const scratch = 'C:\\Users\\u\\AppData\\Local\\Temp\\claude\\x\\scratchpad\\probe.mjs';
    const rule = (toolUseID: string, content: string) => ({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', hookEvent: 'PreToolUse', toolUseID, content },
    });
    const at = (row: Record<string, unknown>, minute: number) => ({
      ...row,
      timestamp: TS(minute),
    });
    const rows = [
      assistant('c1', 1, { input: 0, read: 0, write: 40_000, out: 1 }, [
        use('v1', 'Bash', { command: 'npx vitest run 2>&1 | tail -5' }),
      ]),
      at(result('v1', 'ok'), 5),
      assistant('c2', 6, { input: 0, read: 40_000, write: 20_000, out: 1 }, [
        use('v2', 'Bash', { command: 'npx vitest run src/a.test.ts' }),
        use('k1', 'Bash', { command: 'pnpm build' }),
      ]),
      result('v2', 'ok'),
      result('k1', 'Command timed out after 10m 0s'),
      assistant('c3', 17, { input: 0, read: 60_000, write: 0, out: 1 }, [
        use('s1', 'Bash', { command: 'sleep 120; sleep 1m; ls' }),
      ]),
      result('s1', 'ok'),
      assistant('c4', 20, { input: 0, read: 60_000, write: 0, out: 1 }, [
        use('w1', 'Write', { file_path: scratch, content: 'x' }),
      ]),
      rule('w1', '# Before/after shots\n…'),
      result('w1', 'ok'),
      assistant('c5', 21, { input: 0, read: 60_000, write: 0, out: 1 }, [
        use('w2', 'Write', { file_path: FILE, content: 'x' }),
      ]),
      // Правило на настоящем файле и не-правило на черновике не в счёт.
      rule('w2', '# Before/after shots\n…'),
      result('w2', 'ok'),
      assistant('c6', 22, { input: 0, read: 60_000, write: 0, out: 1 }, [
        use('h1', 'Bash', { command: `cat > ${PATH} <<'EOF'\nx\nEOF` }),
      ]),
      rule('h1', '# Frontend doctrine\n…'),
      rule('w1', 'plain hint'),
      result('h1', 'ok'),
    ];
    const audit = auditClaudeRows('e', rows);
    expect(audit.economy).toEqual({
      // min(40k, контекст) по вызовам / сумма контекстов: 240k / 340k.
      prefixShare: 71,
      wholeChecks: { runs: 1, minutes: 4 },
      capKills: { count: 1, minutes: 10 },
      sleepMinutes: 3,
      // Ни одного короткого чтения: sleep, запись, heredoc и проверки — не то, что batch-nudge сложил бы.
      singleRunShare: 0,
      falseRules: 2,
    });
    const head = headline({ ...audit, subagents: [audit] });
    expect([head.wholeCheckRuns, head.capKillMinutes, head.falseRules]).toEqual([2, 20, 4]);
    expect(head.prefixShare).toBe(71);
    expect(formatSession(audit).some((line) => line.includes('правила на черновиках 2'))).toBe(
      true,
    );
  });

  it('одиночные шаги — короткие чтения подряд, как их видит batch-nudge', () => {
    const bash = (command: string) => ({ name: 'Bash', input: { command } });
    const call = (...uses: { name: string; input: Record<string, unknown> }[]) => ({
      uses,
      context: 1,
    });
    const share = (calls: ReturnType<typeof call>[]) => economyOf([], calls, 1).singleRunShare;
    // ls → git status → grep: два вызова продолжают ряд; текст без инструментов ряд не рвёт.
    expect(
      share([call(bash('ls')), call(), call(bash('git status')), call(bash('grep -n x a.ts'))]),
    ).toBe(67);
    // Запись, проверка, два чтения в одном вызове и длинная строка — не одиночные чтения.
    expect(share([call(bash('ls')), call(bash('cp a b'))])).toBe(0);
    expect(share([call(bash('cp a b')), call(bash('ls'))])).toBe(0);
    expect(share([call(bash('ls')), call(bash('pnpm test'))])).toBe(0);
    expect(share([call(bash('ls')), call(bash('ls'), bash('pwd'))])).toBe(0);
    expect(share([call(bash('ls')), call(bash(`cat ${'x'.repeat(220)}`))])).toBe(0);
  });

  it('правило на heredoc ложное, только когда heredoc — данные', () => {
    const rows = (command: string) => [
      assistant('c1', 1, { input: 0, read: 0, write: 1, out: 1 }, [use('h', 'Bash', { command })]),
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          hookEvent: 'PreToolUse',
          toolUseID: 'h',
          content: '# Verification depth\n…',
        },
      },
    ];
    const falseRules = (command: string) => auditClaudeRows('e', rows(command)).economy?.falseRules;
    expect(falseRules("cat >> notes.md <<'EOF'\npnpm test\nEOF")).toBe(1);
    expect(falseRules("node - <<'EOF'\nconsole.log(1)\nEOF")).toBe(0);
    expect(falseRules("cat > x.mjs <<'EOF'\nconsole.log(1)\nEOF\nnode x.mjs")).toBe(0);
    expect(falseRules("cat <<'EOF' | python3\nprint(1)\nEOF")).toBe(0);
  });

  // На macOS `os.tmpdir()` — `/var/folders/…/T/`: запись туда считалась правкой проекта.
  it('правило на записи во временный каталог Linux и macOS — ложное', () => {
    const falseRules = (file_path: string) =>
      auditClaudeRows('e', [
        assistant('c1', 1, { input: 0, read: 0, write: 1, out: 1 }, [
          use('w', 'Write', { file_path, content: 'x' }),
        ]),
        {
          type: 'attachment',
          attachment: {
            type: 'hook_additional_context',
            hookEvent: 'PreToolUse',
            toolUseID: 'w',
            content: '# Before/after shots\n…',
          },
        },
      ]).economy?.falseRules;
    expect(falseRules('/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/probe.mjs')).toBe(1);
    expect(falseRules('/private/var/folders/zz/abc/T/claude/x/probe.mjs')).toBe(1);
    expect(falseRules('/tmp/claude/x/probe.mjs')).toBe(1);
    expect(falseRules('/Users/u/work/app/src/T/probe.mjs')).toBe(0);
  });
});

describe('token-audit — классы шагов', () => {
  it('узкие классы раньше широких, `cd …&&` не мешает', () => {
    expect(stepClass([])).toBe('text');
    expect(stepClass([{ name: 'Bash', input: { command: 'cd /x && cat a.ts' } }])).toBe('read');
    expect(stepClass([{ name: 'Bash', input: { command: 'node e2e/shots.mjs' } }])).toBe('shots');
    expect(stepClass([{ name: 'Bash', input: { command: 'pnpm lint | tail -3' } }])).toBe('gate');
    expect(stepClass([{ name: 'Bash', input: { command: 'git -C x status' } }])).toBe('git');
    expect(stepClass([{ name: 'mcp__srv__jira_get_issue', input: {} }])).toBe('tracker');
    expect(stepClass([{ name: 'mcp__srv__other', input: {} }])).toBe('mcp');
    expect(stepClass([{ name: 'Grep', input: { pattern: 'x' } }])).toBe('read');
  });
});

describe('token-audit — Codex', () => {
  async function* from(rows: unknown[]): AsyncIterable<string> {
    for (const row of rows) yield JSON.stringify(row);
  }
  const meta = { timestamp: TS(0), type: 'session_meta', payload: { id: 'c1', cwd: 'C:\\demo' } };
  const turn = {
    timestamp: TS(0),
    type: 'turn_context',
    payload: { turn_id: 't1', model: 'gpt-5' },
  };
  const record = (response: string, input: number, cached: number, output: number) => ({
    timestamp: TS(1),
    type: 'token_usage_record',
    payload: {
      turn_id: 't1',
      response_id: response,
      usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    },
  });
  const fn = (name: string) => ({
    timestamp: TS(1),
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: '{}' },
  });

  it('вход у Codex с кешем внутри — чтение кеша вычитается, контекст первого вызова целиком', async () => {
    const audit = await auditForeignLines(
      'c1',
      'codex',
      from([
        meta,
        turn,
        record('r1', 30_000, 0, 100),
        fn('shell'),
        record('r2', 31_000, 30_000, 50),
      ]),
    );
    expect(audit.calls).toBe(2);
    expect(audit.totals).toMatchObject({ input: 31_000, cacheRead: 30_000, output: 150 });
    expect(audit.constant?.firstContext).toBe(30_000);
    expect(audit.maxContext).toBe(31_000);
    expect(audit.tools).toEqual({ shell: { calls: 1, resultChars: 0, errors: 0 } });
  });

  /** Ревью A2-F12: оболочка и патч Codex не подходили ни к одному классу — всё было «прочим». */
  it('виды шагов Codex: гейт, правка и чтение по аргументам его оболочки и патча', async () => {
    const call = (name: string, args: unknown) => ({
      timestamp: TS(1),
      type: 'response_item',
      payload: { type: 'function_call', name, arguments: JSON.stringify(args) },
    });
    const patch = {
      timestamp: TS(1),
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' },
    };
    const audit = await auditForeignLines(
      'c1',
      'codex',
      from([
        meta,
        turn,
        record('r1', 30_000, 0, 10),
        call('shell', { command: ['bash', '-lc', 'cd /x && pnpm lint'] }),
        record('r2', 31_000, 30_000, 10),
        patch,
        record('r3', 32_000, 31_000, 10),
        call('exec_command', { cmd: 'rg foo src' }),
        record('r4', 33_000, 32_000, 10),
        call('Shell', { command: 'git status' }),
        record('r5', 34_000, 33_000, 10),
      ]),
    );
    expect(Object.keys(audit.steps).sort()).toEqual(['edit', 'gate', 'git', 'read', 'text']);
    expect(audit.tools.apply_patch?.calls).toBe(1);
  });

  it('инструменты Qwen Code — те же виды шагов, имя без учёта регистра', () => {
    const of = (name: string, input: Record<string, unknown>) =>
      stepClass([foreignToolUse(name, input)]);
    expect(of('run_shell_command', { command: 'npx vitest run' })).toBe('gate');
    expect(of('shell', { command: ['bash', '-lc', 'cat a.ts'] })).toBe('read');
    expect(of('read_file', { absolute_path: '/x/a.ts' })).toBe('read');
    expect(of('Read_File', { absolute_path: '/x/a.ts' })).toBe('read');
    expect(of('replace', { file_path: '/x/a.ts' })).toBe('edit');
    expect(of('list_directory', { path: '/x' })).toBe('read');
    expect(of('mcp__srv__jira_search', {})).toBe('tracker');
  });

  it('журнал без расхода — ошибка, а не пустой отчёт', async () => {
    await expect(auditForeignLines('c1', 'codex', from([meta, turn]))).rejects.toThrow(
      /не журнал codex/,
    );
  });
});

describe('token-audit — разделение и итоги', () => {
  it('родитель, группы и внуки по `chatLinks`; черновые ключи не берутся, но переводятся алиасом', () => {
    const P = '00000000-0000-4000-8000-000000000001';
    const G1 = '00000000-0000-4000-8000-000000000002';
    const G2 = '00000000-0000-4000-8000-000000000003';
    const R = '00000000-0000-4000-8000-000000000004';
    const state = {
      chatLinks: {
        'new-1-2': { parentChatId: P },
        [G1]: { parentChatId: P },
        [G2]: { parentChatId: P },
        [R]: { parentChatId: 'new-9' },
        '00000000-0000-4000-8000-000000000009': { parentChatId: 'someone-else' },
      },
      chatKeyAliases: { 'new-9': G2 },
    };
    expect(splitSessionIds(state, P)).toEqual([P, G1, G2, R]);
    expect(splitSessionIds({}, P)).toEqual([P]);
  });

  it('группы в чужих CLI (6.4): ключи `<cli>:<id>` с их внуками, чужой родитель; `claude:` не адрес', () => {
    const P = '00000000-0000-4000-8000-000000000001';
    const G = '00000000-0000-4000-8000-000000000002';
    const state = {
      chatLinks: {
        [G]: { parentChatId: P },
        'codex:c1': { parentChatId: P },
        'qwen:q1': { parentChatId: P },
        'codex:c1-review': { parentChatId: 'codex:c1' },
        'claude:x': { parentChatId: P },
        'new-1-2': { parentChatId: P },
        'qwen:q9': { parentChatId: 'qwen:root' },
      },
    };
    expect(splitChats(state, P)).toEqual({
      claude: [P, G],
      foreign: [
        { providerId: 'codex', chatId: 'c1' },
        { providerId: 'qwen', chatId: 'q1' },
        { providerId: 'codex', chatId: 'c1-review' },
      ],
    });
    expect(splitSessionIds(state, P)).toEqual([P, G]);
    expect(splitChats(state, 'qwen:root')).toEqual({
      claude: [],
      foreign: [
        { providerId: 'qwen', chatId: 'root' },
        { providerId: 'qwen', chatId: 'q9' },
      ],
    });
  });

  it('сумма: счётчики складываются, контексты — средние и наибольший; потолки', () => {
    const a = auditClaudeRows('a', sampleRows());
    const b = auditClaudeRows('b', sampleRows().slice(0, 10));
    const t = totalHeadline([a, b]);
    expect(t.calls).toBe(a.calls + b.calls);
    expect(t.cacheRead).toBe(a.totals.cacheRead + b.totals.cacheRead);
    expect(t.firstContext).toBe(74_010);
    expect(t.maxContext).toBe(78_005);
    expect(t.averageContext).toBe(
      Math.round((a.averageContext * a.calls + b.averageContext * b.calls) / (a.calls + b.calls)),
    );
    expect(checkLimits(t, { firstContext: 80_000 })).toEqual([]);
    expect(checkLimits(t, { firstContext: 45_000 })).toEqual([
      'firstContext 74010 > потолка 45000',
    ]);
    expect(checkLimits(t, { nope: 1 } as never)).toEqual(['nope: такого числа нет в отчёте']);
  });
});

describe('token-audit — файлы и командная строка', () => {
  let config: string;
  const ID = '11111111-2222-4333-8444-555555555555';
  const TOOL = fileURLToPath(new URL('../../../../../../tools/token-audit.mjs', import.meta.url));

  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'token-audit-'));
    const project = join(config, 'projects', 'C--repo');
    mkdirSync(join(project, ID, 'subagents'), { recursive: true });
    writeFileSync(join(project, `${ID}.jsonl`), lines(sampleRows()));
    writeFileSync(
      join(project, ID, 'subagents', 'agent-a.jsonl'),
      lines(sampleRows().slice(0, 10)),
    );
    // Агент, убитый до первого ответа: расхода нет, отчёт не падает.
    writeFileSync(join(project, ID, 'subagents', 'agent-b.jsonl'), lines(sampleRows().slice(0, 3)));
  });

  afterEach(() => {
    rmSync(config, { recursive: true, force: true });
  });

  it('сессия по id вместе с вложенными агентами', () => {
    const file = findClaudeTranscript(config, ID)!;
    const audit = auditClaudeFile(file, ID);
    expect(audit.subagents.map((s) => s.calls)).toEqual([2]);
    expect(headline(audit).subagentCalls).toBe(2);
    expect(findClaudeTranscript(config, 'nope')).toBeUndefined();
  });

  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', TOOL, ...args], {
      encoding: 'utf8',
    });

  /** Ревью B2-F20: 23.0–23.5 читают TypeScript только с флагом, а перезапуск знал лишь 22-ю. */
  it('перезапуск с флагом: 22 до 18-й и 23 до 6-й, новее — без него', async () => {
    const href = new URL('../../../../../../tools/token-audit.mjs', import.meta.url).href;
    const { needsStripFlag } = (await import(href)) as {
      needsStripFlag: (version: string) => boolean;
    };
    const flagged = ['22.6.0', '22.17.1', '23.0.0', '23.5.0'];
    const plain = ['22.18.0', '23.6.0', '24.13.0', '20.19.0'];
    expect(flagged.filter((v) => !needsStripFlag(v))).toEqual([]);
    expect(plain.filter((v) => needsStripFlag(v))).toEqual([]);
  });

  it('командная строка: отчёт 0, превышенный потолок 1, нечитаемый вход 2', () => {
    const ok = run(ID, '--config', config);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('вызовы 6');
    expect(ok.stdout).toContain('отложенные инструменты 4');

    const json = JSON.parse(run(ID, '--config', config, '--json').stdout);
    expect(json.total.calls).toBe(6);

    const over = run(ID, '--config', config, '--limits', '{"firstContext":45000}');
    expect(over.status).toBe(1);
    expect(over.stderr).toContain('firstContext 74010 > потолка 45000');

    const broken = join(config, 'broken.jsonl');
    writeFileSync(broken, '{"type":"user"}\nnot json\n{"type":"user"}\n');
    const bad = run('--file', broken);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('испорченные строки 2');

    expect(run('missing-id', '--config', config).status).toBe(2);
  });
});

/**
 * 6.4: журналы разговора чужого CLI узнаются по каталогу разговора и его ходам.
 * Разговор и журналы — в той форме, что пишут хранилище панели и настоящие CLI
 * (`scanner/foreign.ts`); время — от часа назад, чтобы файлы прошли отбор по mtime.
 */
describe('token-audit — журналы разговоров Codex и Qwen', () => {
  let root: string;
  let appData: string;
  let qwenHome: string;
  let codexHome: string;
  let workdir: string;
  const T0 = Date.now() - 3_600_000;
  const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

  const qwenLog = (name: string, cwd: string, seconds: number, prompt?: string) => {
    const dir = join(qwenHome, 'projects', 'p', 'chats');
    mkdirSync(dir, { recursive: true });
    const asked = prompt
      ? [
          {
            uuid: `q-${name}`,
            sessionId: name,
            timestamp: at(seconds - 1),
            type: 'user',
            cwd,
            message: { role: 'user', parts: [{ text: prompt }] },
          },
        ]
      : [];
    const row = {
      uuid: `u-${name}`,
      sessionId: name,
      timestamp: at(seconds),
      type: 'system',
      cwd,
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          response_id: `r-${name}`,
          model: 'qwen3-coder-plus',
          input_token_count: 1000,
          output_token_count: 10,
          cached_content_token_count: 0,
        },
      },
    };
    writeFileSync(join(dir, `${name}.jsonl`), lines([...asked, row]));
    return join(dir, `${name}.jsonl`);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'token-audit-foreign-'));
    appData = join(root, 'config', 'agentdeck');
    qwenHome = join(root, 'qwen-home');
    codexHome = join(root, 'codex-home');
    workdir = join(root, 'copies', 'feature-login');
    mkdirSync(workdir, { recursive: true });
    createChat(appData, 'qwen', { id: 'q1', title: 'Форма входа', workdir });
    // Ход 1 отвечен, ход 2 — ещё идёт.
    appendMessage(appData, 'qwen', 'q1', { role: 'user', content: 'починить', at: at(0) });
    appendMessage(appData, 'qwen', 'q1', { role: 'assistant', content: 'ok', at: at(60) });
    appendMessage(appData, 'qwen', 'q1', { role: 'user', content: 'дальше', at: at(600) });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const one = async (
    ref: { providerId: string; chatId: string },
    homes: Partial<Record<'codex' | 'qwen', string[]>> = { qwen: [qwenHome] },
  ) => (await foreignChatLogs({ appData, refs: [ref], homes }))[0]!;

  it('свой каталог и ход — журнал разговора; чужой каталог и время между ходами — нет', async () => {
    const turn1 = qwenLog(
      'a-turn1',
      process.platform === 'win32' ? workdir.toUpperCase() : workdir,
      10,
    );
    qwenLog('b-other-dir', join(root, 'copies', 'feature-header'), 10);
    qwenLog('c-between-turns', workdir, 300);
    const turn2 = qwenLog('d-turn2', `${workdir}${sep}`, 700);
    const logs = await one({ providerId: 'qwen', chatId: 'q1' });
    expect(logs).toMatchObject({ key: 'qwen:q1', kind: 'qwen', title: 'Форма входа' });
    expect(logs.missing).toBeUndefined();
    expect([...logs.files].sort()).toEqual([turn1, turn2].sort());
  });

  it('общий каталог: журнал — тому, чья реплика в нём целиком и длиннее; родитель, которого цитируют группы, — свой', async () => {
    const shared = join(root, 'repo');
    mkdirSync(shared, { recursive: true });
    // Задание группы цитирует слова человека из родителя, как настоящее.
    const OWNER = 'PLAIN words of the owner request';
    const PREAMBLE = 'Owner request, verbatim — the same preamble for every group';
    const chats = [
      ['p', OWNER],
      ['g1', `${OWNER}\n${PREAMBLE}\n\nпочинить валидацию формы входа`],
      ['g2', `${OWNER}\n${PREAMBLE}\n\nубрать лишний отступ в шапке`],
    ] as const;
    for (const [id, content] of chats) {
      createChat(appData, 'qwen', { id, title: id, workdir: shared });
      appendMessage(appData, 'qwen', id, { role: 'user', content, at: at(0) });
      appendMessage(appData, 'qwen', id, { role: 'assistant', content: 'ok', at: at(120) });
    }
    const parent = qwenLog('p-log', shared, 5, OWNER);
    const first = qwenLog('g1-log', shared, 20, chats[1][1]);
    const second = qwenLog('g2-log', shared, 15, chats[2][1]);
    const nobody = qwenLog('nobody', shared, 30, 'совсем другой разговор того же каталога');
    // Преамбула есть у обеих групп, но ни одна реплика не стоит целиком.
    const preamble = qwenLog('preamble-only', shared, 40, PREAMBLE);
    const logs = await foreignChatLogs({
      appData,
      refs: chats.map(([chatId]) => ({ providerId: 'qwen', chatId })),
      homes: { qwen: [qwenHome] },
    });
    expect(logs.map((chat) => chat.files)).toEqual([[parent], [first], [second]]);
    // Ничьи журналы в счёт не идут, но названы у каждого претендента (ревью A2-F11).
    expect(logs.map((chat) => chat.contested)).toEqual([
      [nobody, preamble],
      [nobody, preamble],
      [nobody, preamble],
    ]);
  });

  it('Codex — по cwd из session_meta; нечего узнать — причина строкой, а не пустой отчёт', async () => {
    createChat(appData, 'codex', { id: 'c1', workdir });
    appendMessage(appData, 'codex', 'c1', { role: 'user', content: 'x', at: at(0) });
    appendMessage(appData, 'codex', 'c1', { role: 'assistant', content: 'y', at: at(30) });
    const day = join(codexHome, 'sessions', '2026', '10', '17');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, 'rollout-c1.jsonl');
    writeFileSync(
      rollout,
      lines([
        { timestamp: at(1), type: 'session_meta', payload: { id: 's1', cwd: workdir } },
        { timestamp: at(1), type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5' } },
        {
          timestamp: at(5),
          type: 'token_usage_record',
          payload: {
            turn_id: 't1',
            response_id: 'r1',
            usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 9 },
          },
        },
      ]),
    );
    const ref = { providerId: 'codex', chatId: 'c1' };
    expect((await one(ref, { codex: [codexHome] })).files).toEqual([rollout]);
    expect((await one(ref, { codex: [qwenHome] })).missing).toMatch(
      /журналов codex из .* за время ходов нет/,
    );
    expect((await one({ providerId: 'qwen', chatId: 'nope' })).missing).toMatch(/разговора нет/);
    expect((await one({ providerId: 'gemini', chatId: 'g' })).missing).toBe(
      'журналы gemini измеритель не читает',
    );
    createChat(appData, 'qwen', { id: 'no-dir' });
    expect((await one({ providerId: 'qwen', chatId: 'no-dir' })).missing).toBe(
      'у разговора нет каталога',
    );
  });

  it('командная строка: `--split` считает группу Qwen по её журналу рядом с сессией Claude', () => {
    const P = '11111111-2222-4333-8444-555555555555';
    const project = join(root, 'config', 'projects', 'C--repo');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${P}.jsonl`), lines(sampleRows()));
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        chatLinks: { 'qwen:q1': { parentChatId: P }, 'qwen:gone': { parentChatId: P } },
      }),
    );
    qwenLog('a-turn1', workdir, 10);
    const TOOL = fileURLToPath(new URL('../../../../../../tools/token-audit.mjs', import.meta.url));
    const out = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        TOOL,
        '--split',
        P,
        '--config',
        join(root, 'config'),
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, QWEN_HOME: qwenHome } },
    );
    expect(out.status, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(report.sessions.map((s: { kind: string; title?: string }) => [s.kind, s.title])).toEqual(
      [
        ['claude', undefined],
        ['qwen', 'qwen:q1 Форма входа'],
      ],
    );
    expect(report.total.calls).toBe(7);
    expect(out.stderr).toContain('qwen:gone: разговора нет');
  });
});

describe('token-audit — время по часам и занятость', () => {
  const U = { input: 1, read: 0, write: 0, out: 1 };
  const prompt = (minute: number) => ({
    type: 'user',
    timestamp: TS(minute),
    message: { role: 'user', content: 'сделай' },
  });
  const done = (id: string, minute: number) => ({ ...result(id, 'ok'), timestamp: TS(minute) });
  const end = (id: string, minute: number) => {
    const row = assistant(id, minute, U, [{ type: 'text', text: 'готово' }]);
    (row.message as Record<string, unknown>).stop_reason = 'end_turn';
    return row;
  };

  // Главный: промпт 0, модель до 1, инструмент 1→5, модель до 6, конец хода; простой
  // 6→20; промпт 20, модель до 21, конец. Агент: 2→10, инструмент 3→9.
  const main = auditClaudeRows('main', [
    prompt(0),
    assistant('m1', 1, U, [use('t1', 'Bash', { command: 'pnpm test' })]),
    done('t1', 5),
    end('m2', 6),
    prompt(20),
    end('m3', 21),
  ] as never);
  const agent = auditClaudeRows('agent', [
    prompt(2),
    assistant('a1', 3, U, [use('t2', 'Bash', { command: 'node mustfail.mjs' })]),
    done('t2', 9),
    end('a2', 10),
  ] as never);
  main.subagents.push(agent);

  it('стена — от первой записи до последней, с агентами; простой между ходами не занятость', () => {
    const h = headline(main);
    expect(h.wallMs).toBe(21 * 60_000);
    // Занят хоть кто-то: 0→10 (главный 0→6 и агент 2→10 перекрылись) + 20→21.
    expect(h.activeMs).toBe(11 * 60_000);
    // Сумма по агентам: главный 6+1 мин, агент 8 мин — больше занятости.
    expect(h.agentTimeMs).toBe(15 * 60_000);
    expect(h.toolMs).toBe(4 * 60_000 + 6 * 60_000);
    expect(h.modelMs).toBe(h.agentTimeMs - h.toolMs);
  });

  it('вызов без результата занят до последней записи, не «до сейчас»', () => {
    const cut = auditClaudeRows('cut', [
      prompt(0),
      assistant('c1', 1, U, [use('t9', 'Bash', { command: 'sleep 600' })]),
      prompt(4),
    ] as never);
    expect(cut.time?.toolMs).toBe(3 * 60_000);
  });

  it('итог разделения: сессии разом — стена и занятость общие, не сумма', () => {
    const t = totalHeadline([main, agent]);
    expect(t.wallMs).toBe(21 * 60_000);
    expect(t.activeMs).toBe(11 * 60_000);
  });
});
