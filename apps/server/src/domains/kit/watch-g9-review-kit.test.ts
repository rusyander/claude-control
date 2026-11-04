import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Находки наблюдения за группой g9 (26.10, стадия проверки), стражи набора.
 * Запуск — через диспетчер событий `hooks/lib/run.mjs`, как его зовёт hooks.json.
 *
 * F3: 8 сжатий за стадию исправления, после каждого — отказ карточки правила и повторное чтение того же
 *     правила на 5–16 тыс. знаков. Окно, которое попросил бы гейт, теперь приходит ТЕКСТОМ на старте
 *     после сжатия: это и есть чтение — гейт не взводится, следующая правка проходит.
 * F5: «полный гейт уже прогнан» — ключ по скрипту гейта и его аргументам, а не по строке команды:
 *     `timeout 900`, `NODE_OPTIONS=…`, `./`, кавычки, `cd <тот же каталог> &&`, `cd пакет && node ../scripts/…`
 *     — тот же гейт (раньше — новый гейт или вовсе не гейт). Правило сессии: после зелёного гейта и правок
 *     повтор — «уже прогнан», полный гейт ещё раз только в доставке (стадий группы в хуке больше нет).
 */

// AGENTDECK_KIT_UNDER_TEST — копия набора для прогона «красный до» против старого кода; без неё — встроенный.
const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-g9-review-'));
const STATE = join(dir, 'state');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type HookOut = {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
function hook(event: string, payload: object, env: NodeJS.ProcessEnv = {}): HookOut {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_STATE: STATE,
      AGENTDECK_KIT_CLI: '',
      AGENTDECK_STEP_KIND: '',
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  return (event === 'pre' || event === 'session') && out ? (JSON.parse(out) as HookOut) : {};
}
const decision = (o: HookOut) => o.hookSpecificOutput?.permissionDecision;
const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';

let n = 0;
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

describe('F3 rule-injector: после сжатия окно правила приходит текстом, отказа карточки нет', () => {
  const RULE_FILE = join(KIT, 'skills', 'situational-rules', 'references', 'visible-fix-shots.md');
  const FULL = readFileSync(RULE_FILE, 'utf8')
    .trim()
    .split('<kit>')
    .join(resolve(KIT).split('\\').join('/'));
  // Копия вне временного каталога: правка во временном — черновик, правило о UI её не касается.
  const copy = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-g9-review-'));
  mkdirSync(join(copy, '.git'), { recursive: true });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));
  const CHILD = { AGENTDECK_STEP_KIND: 'implement' };
  const UI = join(copy, 'inst-admin-ui/src/pages/users/CreateRolePage/index.tsx');
  const input = { file_path: UI, old_string: 'a', new_string: 'b' };
  const editPre = (session: string, tp: string) =>
    hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        session_id: session,
        transcript_path: tp,
        cwd: copy,
        tool_name: 'Edit',
        tool_input: input,
      },
      CHILD,
    );
  const before = [
    prompt('сделай'),
    {
      type: 'assistant',
      cwd: copy,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input }],
      },
    },
  ];
  const after = [...before, { type: 'system', subtype: 'compact_boundary' }, prompt('продолжай')];

  it('стадия исправления: правило целиком → сжатие → старт с текстом окна → правка проходит без Read', () => {
    const session = 'kg9r-text-a';
    const first = editPre(session, transcript([prompt('сделай')]));
    expect(decision(first)).toBeUndefined();
    expect(ctx(first)).toContain(FULL);
    hook(
      'precompact',
      { hook_event_name: 'PreCompact', session_id: session, transcript_path: transcript(before) },
      CHILD,
    );
    const start = hook(
      'session',
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: session,
        transcript_path: transcript(after),
        cwd: copy,
      },
      CHILD,
    );
    expect(ctx(start)).toContain('rule text after compaction');
    expect(ctx(start)).toContain(FULL);
    expect(ctx(start)).not.toContain('rule-cards after compaction');
    const next = editPre(session, transcript(after));
    expect(decision(next), reason(next)).toBeUndefined();
    // Текст уже в окне: правка не тянет правило второй раз.
    expect(ctx(next)).not.toContain(FULL);
  });

  it('гейт, взведённый до сжатия и не снятый чтением, снимается текстом окна на старте', () => {
    const session = 'kg9r-lift-c';
    expect(decision(editPre(session, transcript([prompt('сделай')])))).toBeUndefined();
    const compact = () =>
      hook(
        'precompact',
        { hook_event_name: 'PreCompact', session_id: session, transcript_path: transcript(before) },
        CHILD,
      );
    compact();
    // Первое поколение после сжатия: чтение UI-файла принесло карточку и взвело гейт (чтение не отказывают),
    // правило так и не прочитано.
    const look = hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        session_id: session,
        transcript_path: transcript(after),
        cwd: copy,
        tool_name: 'Read',
        tool_input: { file_path: UI },
      },
      CHILD,
    );
    expect(decision(look)).toBeUndefined();
    expect(ctx(look)).toContain('card (task step');
    compact();
    const start = hook(
      'session',
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: session,
        transcript_path: transcript(after),
        cwd: copy,
      },
      CHILD,
    );
    expect(ctx(start)).toContain('rule text after compaction');
    const next = editPre(
      session,
      transcript([...after, { type: 'system', subtype: 'compact_boundary' }]),
    );
    expect(decision(next), reason(next)).toBeUndefined();
  });

  it('вне группы (не дочерний процесс разделения) старт после сжатия молчит о правилах', () => {
    const session = 'kg9r-human-b';
    const start = hook('session', {
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: session,
      transcript_path: transcript(after),
      cwd: copy,
    });
    expect(ctx(start)).not.toContain('rule text after compaction');
  });
});

describe('F5 gate-at-end: переписанный вызов гейта — тот же гейт', () => {
  // Вне git — журнала копии нет, судит история сессии; каталог с пакетом, как в большом монорепозитории.
  const repo = mkdtempSync(join(dir, 'reword-'));
  mkdirSync(join(repo, 'inst-admin-ui'), { recursive: true });
  const GATE = 'node scripts/check_frontend_tests.mjs > .agent/tmp/deliver-check-tests.log 2>&1';
  const stamp = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const call = (name: string, input: object, id: string) => ({
    type: 'assistant',
    timestamp: stamp(-60_000),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const done = (id: string, content: string) => ({
    type: 'user',
    timestamp: stamp(-59_000),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  // g9 09:42: гейт тестов прогнан, затем 22 правки; сообщение — не доставка.
  const ran = [
    { type: 'user', timestamp: stamp(-120_000), message: { role: 'user', content: 'сделай' } },
    call('Bash', { command: GATE }, 'r1'),
    done('r1', 'rc=0 OK inst-admin-ui'),
    call('Edit', { file_path: 'inst-admin-ui/src/a.ts' }, 'e1'),
    done('e1', 'ok'),
  ];
  const gate = (command: string) =>
    hook('pre', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: true },
      tool_use_id: `g${++n}`,
      cwd: repo,
      transcript_path: transcript(ran),
      session_id: `g9r-${n}`,
    });
  const reworded = [
    'timeout 900 node scripts/check_frontend_tests.mjs > .agent/tmp/t2.log 2>&1; echo rc=$?',
    'node "scripts/check_frontend_tests.mjs" > .agent/tmp/t3.log',
    `cd ${repo.split('\\').join('/')} && node scripts/check_frontend_tests.mjs > x.log 2>&1`,
    'cd inst-admin-ui && node ../scripts/check_frontend_tests.mjs > ../x.log 2>&1',
  ];

  it('10:05–10:48: каждое переписанное написание — «уже прогнан»', () => {
    for (const command of reworded) {
      const out = gate(command);
      expect(decision(out), command).toBe('deny');
      expect(reason(out), command).toContain('already ran');
    }
    // Обрезанный вывод отклоняется раньше, своим текстом — но это тоже гейт.
    const cut = gate('CI=1 FORCE_COLOR=0 node ./scripts/check_frontend_tests.mjs 2>&1 | tail -40');
    expect(decision(cut)).toBe('deny');
    expect(reason(cut)).toContain('whole output');
  });

  it('другие аргументы — другой прогон; соседний скрипт гейта — первый прогон', () => {
    expect(
      reason(gate('node scripts/check_frontend_tests.mjs --only inst-admin-ui > x.log')),
    ).not.toContain('already ran');
    expect(reason(gate('node scripts/check_frontend.mjs > x.log 2>&1'))).not.toContain(
      'already ran',
    );
  });

  it('гейт без скрипта: `cd <тот же каталог> && …` — тот же гейт, `cd пакет && …` — другой', () => {
    const FULL = 'pnpm type-check && pnpm lint && pnpm test';
    const tp = transcript([
      { type: 'user', timestamp: stamp(-120_000), message: { role: 'user', content: 'сделай' } },
      call('Bash', { command: FULL }, 'r2'),
      done('r2', 'rc=0'),
      call('Edit', { file_path: 'inst-admin-ui/src/a.ts' }, 'e2'),
      done('e2', 'ok'),
    ]);
    const run = (command: string) =>
      hook('pre', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command, run_in_background: true },
        tool_use_id: `g${++n}`,
        cwd: repo,
        transcript_path: tp,
        session_id: `g9r-${n}`,
      });
    const same = run(`cd ${repo.split('\\').join('/')} && ${FULL}`);
    expect(decision(same), reason(same)).toBe('deny');
    expect(reason(same)).toContain('already ran');
    expect(reason(run(`cd inst-admin-ui && ${FULL}`))).not.toContain('already ran');
  });
});

describe('R76 gate-at-end: файл гейт-раннера, названный, а не запущенный, — не гейт', () => {
  // Наблюдение 26.10 15:27: присваивание пути и diff/sed над gate-run.mjs получили «full gate» отказ.
  const fg = (command: string) =>
    hook('pre', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: `r${++n}`,
      cwd: dir,
      transcript_path: transcript([prompt('сделай')]),
      session_id: `g9r-${n}`,
    });
  it('присваивание пути, diff <(sed … gate-run.mjs), cat, --dry и --help — без отказа', () => {
    for (const command of [
      'K=/c/work/agentdeck/apps/server/assets/kit/agentdeck-kit/tools/gate-run.mjs',
      "diff <(sed 's/\r$//' ~/.claude/tools/gate-run.mjs) <(sed 's/\r$//' /c/work/x/tools/gate-run.mjs) && echo same",
      'cat .claude/tools/check-ticket.mjs | head -40',
      'node C:/work/x/tools/gate-run.mjs --dry --ticket PROJ-1 "lint=npm run lint"',
      'node .claude/tools/check-ticket.mjs --help',
      // `node --check` только разбирает файл (cmd-duration KNOWN_GATES считал это долгим гейтом).
      'node --check C:/work/x/tools/gate-run.mjs && echo syntax-ok',
    ])
      expect(decision(fg(command)), command).toBeUndefined();
  });
  it('запуск как команды — гейт: node <путь>, timeout 900 node, в кавычках, через $K, check-ticket', () => {
    for (const command of [
      'node C:/work/x/tools/gate-run.mjs --ticket PROJ-1 "lint=npm run lint" "test=npm test"',
      'timeout 900 node /c/work/x/tools/gate-run.mjs --ticket PROJ-1 > .agent/tmp/g.log 2>&1',
      'node "C:/work/x/tools/gate-run.mjs" --ticket PROJ-1',
      'K=/c/work/x/tools/gate-run.mjs; node "$K" --ticket PROJ-1',
      'node .claude/tools/check-ticket.mjs --ticket PROJ-1',
    ]) {
      const out = fg(command);
      expect(decision(out), command).toBe('deny');
      expect(reason(out), command).toContain('gate-at-end');
    }
  });
});

// g8 deliver audit F10 (26.10): отчёт негативного сита называл только покрасневшую пробу — две пробы, которые
// должны были получить отказ и прошли, в MR не попали. Текст навыков — это и есть поведение агента группы.
describe('F10 навыки доставки: каждая негативная проба — с вводом и кодом, прошедшая — находка', () => {
  const flat = (rel: string) => readFileSync(join(KIT, 'skills', rel), 'utf8').replace(/\s+/g, ' ');
  it('prepare-mr: доказательство негативного сита перечисляет КАЖДУЮ пробу, прошедшая — находка', () => {
    const text = flat(join('prepare-mr', 'SKILL.md'));
    expect(text).toContain(
      "A negative sieve's evidence lists EVERY probe tried with its input and rc, not just the one that went red",
    );
    expect(text).toContain(
      'a probe that should have been refused and passed is a finding — fixed, or an MR «stays open» item naming the gap',
    );
  });
  it('ticket-delivery-2: живая проверка сообщает каждую пробу, прошедшая — находка', () => {
    const text = flat(join('ticket-delivery-2', 'SKILL.md'));
    expect(text).toContain(
      'Every negative probe tried is reported with its input and rc, not only the one that went red',
    );
    expect(text).toContain(
      'one that should have been refused and passed is a finding — fixed, or a «stays open» item of the MR naming the gap',
    );
  });
});
