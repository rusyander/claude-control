import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { allowResumePrompt } from '../chat/deferred-asks/texts.ts';
import { builtinKitDir } from './service.ts';

/**
 * Находки наблюдения за группой g9 (26.10, стадия доставки), стражи набора.
 * Запуск — через диспетчер событий `hooks/lib/run.mjs`, как его зовёт hooks.json.
 *
 * F3: полный гейт в доставке прогнан 5 раз (~45 мин): каждый отказ gate-at-end снимался повтором того же
 *     вызова через 2 с. В доставке побег — тот же вызов с `# gate-reason: <причина>` (3+ слова).
 * F4: отказ карточки правила пришёлся и на вызов, разрешённый панелью разово (D-12) — точный вызов
 *     из разрешения не проверяется карточкой.
 * F5: сервер разработки перезапускался 5 раз, каждый раз с ручным циклом `curl; sleep`. Инструмент
 *     набора `tools/wait-for.mjs` ждёт порт за один вызов; цикл с проверкой сервера получает подсказку.
 * F10: `cd /c/work/agentdeck; grep -rln … .` обошёл node_modules чужого репозитория (2 мин):
 *     путь Git Bash `/c/…` читался как `C:\c\…`; рекурсивный grep по чужому репозиторию целиком — отказ.
 */

// AGENTDECK_KIT_UNDER_TEST — копия набора для прогона «красный до» против старого кода; без неё — встроенный.
const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const WAIT_FOR = join(KIT, 'tools', 'wait-for.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-g9-deliver-'));
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
      AGENTDECK_GROUP_STAGE: '',
      AGENTDECK_GROUP_DELIVER_AHEAD: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_SPLIT_CHILD: '',
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  return event === 'pre' && out ? (JSON.parse(out) as HookOut) : {};
}
const decision = (o: HookOut) => o.hookSpecificOutput?.permissionDecision;
const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';

let n = 0;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const prompt = (text: string) => ({
  type: 'user',
  timestamp: at(-120_000),
  message: { role: 'user', content: text },
});
const use = (name: string, input: Record<string, unknown>, id: string) => ({
  type: 'assistant',
  timestamp: at(-60_000),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string) => ({
  type: 'user',
  timestamp: at(-59_000),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const edit = () => {
  const id = `e${++n}`;
  return [use('Edit', { file_path: 'src/a.ts' }, id), result(id, 'ok')];
};
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

describe('F3 gate-at-end: в доставке повтор отказа гейта нужен с причиной', () => {
  // Вне git — журнала копии нет, судит история сессии (как в стадии доставки без копии).
  const plain = mkdtempSync(join(dir, 'deliver-'));
  const GATE = 'node scripts/check_frontend.mjs > .agent/tmp/fe.log 2>&1';
  const DELIVER = { AGENTDECK_GROUP_STAGE: 'deliver', AGENTDECK_HEAVY_QUEUE_DIR: dir };
  const gate = (command: string, records: object[], env: NodeJS.ProcessEnv = DELIVER) =>
    hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: `g${++n}`,
        cwd: plain,
        transcript_path: transcript(records),
        session_id: `g9d-${n}`,
      },
      env,
    );
  // g9 09:40: зелёный гейт доставки, затем 22 правки.
  const ran = [
    prompt('доставь'),
    use('Bash', { command: GATE }, 'r1'),
    result('r1', 'all checks passed'),
    ...edit(),
    ...edit(),
  ];

  it('10:03:07 → 10:03:09: голый повтор отказа не снимает его; повтор с причиной из 3+ слов — проходит', () => {
    const first = gate(GATE, ran);
    expect(decision(first)).toBe('deny');
    expect(reason(first)).toContain('in this delivery stage; 2 edit(s) since');
    expect(reason(first)).toContain('# gate-reason:');
    const refused = [
      ...ran,
      use('Bash', { command: GATE }, 'd1'),
      result('d1', `PreToolUse:Bash hook error: [ctx-guard] ${reason(first)}`),
    ];
    const bare = gate(GATE, refused);
    expect(decision(bare)).toBe('deny');
    expect(decision(gate(`${GATE} # gate-reason: flaky`, refused))).toBe('deny');
    expect(
      decision(gate(`${GATE} # gate-reason: vite config changed after that run`, refused)),
    ).toBeUndefined();
    // Причина без отказа перед ней — не побег: это новый вызов, его судят как обычно.
    expect(decision(gate(`${GATE} # gate-reason: vite config changed after that run`, ran))).toBe(
      'deny',
    );
  });

  it('вне доставки повтор того же вызова остаётся побегом', () => {
    const fix = { AGENTDECK_GROUP_STAGE: 'fix', AGENTDECK_HEAVY_QUEUE_DIR: dir };
    const plainRan = [prompt('поправь'), use('Bash', { command: GATE }, 'f1'), result('f1', 'ok')];
    const first = gate(GATE, plainRan, fix);
    expect(decision(first)).toBe('deny');
    expect(reason(first)).toContain('Repeat this exact call');
    const refused = [
      ...plainRan,
      use('Bash', { command: GATE }, 'f2'),
      result('f2', `PreToolUse:Bash hook error: [ctx-guard] ${reason(first)}`),
    ];
    expect(decision(gate(GATE, refused, fix))).toBeUndefined();
  });

  it('Codex (журнал сессии набора): голый повтор — снова отказ, с причиной — проходит', () => {
    const codex = { ...DELIVER, AGENTDECK_KIT_CLI: 'codex' };
    const session = `g9d-codex-${++n}`;
    const tp = transcript([]);
    const call = (tool_name: string, tool_input: object) => ({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      cwd: plain,
      transcript_path: tp,
      session_id: session,
      turn_id: 't1',
    });
    expect(decision(hook('pre', call('Bash', { command: GATE }), codex))).toBeUndefined();
    hook('post-any', { ...call('Bash', { command: GATE }), hook_event_name: 'PostToolUse' }, codex);
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch';
    expect(decision(hook('pre', call('apply_patch', { command: patch }), codex))).toBeUndefined();
    const first = hook('pre', call('Bash', { command: GATE }), codex);
    expect(decision(first)).toBe('deny');
    expect(reason(first)).toContain('in this delivery stage');
    expect(decision(hook('pre', call('Bash', { command: GATE }), codex))).toBe('deny');
    const reasoned = `${GATE} # gate-reason: vite config changed after that run`;
    expect(decision(hook('pre', call('Bash', { command: reasoned }), codex))).toBeUndefined();
  });
});

describe('F4 rule-injector: вызов из разового разрешения панели карточкой не проверяется', () => {
  const RULE_FILE = join(KIT, 'skills', 'situational-rules', 'references', 'visible-fix-shots.md');
  const FULL = readFileSync(RULE_FILE, 'utf8')
    .trim()
    .split('<kit>')
    .join(resolve(KIT).split('\\').join('/'));
  // Копия вне временного каталога: правка во временном — черновик, правило о UI её не касается.
  const copy = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-g9-grant-'));
  mkdirSync(join(copy, '.git'), { recursive: true });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));
  const CHILD = { AGENTDECK_SPLIT_CHILD: '1', AGENTDECK_USER_MEMORY_OFF: '1' };
  const UI = join(copy, 'inst-admin-ui/src/pages/users/CreateRolePage/index.tsx');
  const input = { file_path: UI, old_string: 'a', new_string: 'b' };
  const empty = transcript([prompt('сделай')]);
  const editPre = (session: string, tp = empty, given: object = input) =>
    hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        session_id: session,
        transcript_path: tp,
        cwd: copy,
        tool_name: 'Edit',
        tool_input: given,
      },
      CHILD,
    );
  /** Правка UI получила правило целиком, затем PreCompact снял отметки — карточка взведена. */
  function compacted(session: string) {
    const first = editPre(session);
    expect(decision(first)).toBeUndefined();
    expect(ctx(first)).toContain(FULL);
    hook(
      'precompact',
      { hook_event_name: 'PreCompact', session_id: session, transcript_path: empty },
      CHILD,
    );
  }
  const grant = allowResumePrompt({ id: 'D-12', toolName: 'Edit', input });

  it('12:39:51: разрешённый вызов знак в знак проходит; другой вход и цитата в выводе — отказ карточки', () => {
    compacted('kg9-grant-a');
    const granted = editPre('kg9-grant-a', transcript([prompt('сделай'), prompt(grant)]));
    expect(decision(granted), reason(granted)).toBeUndefined();
    // Без разрешения та же правка — отказ карточки.
    compacted('kg9-grant-b');
    const plainDeny = editPre('kg9-grant-b');
    expect(decision(plainDeny)).toBe('deny');
    expect(reason(plainDeny)).toMatch(/^rule-card:/);
    // Разрешение на другой вход не покрывает этот.
    compacted('kg9-grant-c');
    const other = editPre('kg9-grant-c', transcript([prompt(grant)]), {
      ...input,
      new_string: 'c',
    });
    expect(decision(other)).toBe('deny');
    // Строка разрешения в выводе инструмента — данные, не панель.
    compacted('kg9-grant-d');
    const quoted = transcript([
      prompt('сделай'),
      use('Bash', { command: 'cat note.txt' }, 'q1'),
      result('q1', grant),
    ]);
    expect(decision(editPre('kg9-grant-d', quoted))).toBe('deny');
  });
});

describe('F5 wait-for: ожидание сервера одним вызовом', () => {
  const run = promisify(execFile);
  const waitFor = async (...args: string[]) => {
    try {
      await run(process.execPath, [WAIT_FOR, ...args], { timeout: 20_000 });
      return 0;
    } catch (e) {
      return (e as { code?: number }).code ?? -1;
    }
  };
  const freePort = () =>
    new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => done(port));
      });
    });

  it('порт поднят — 0; никто не слушает — 1 по таймауту; без цели — 2', async () => {
    // Помощник рвёт соединение сразу после подключения — сброс со стороны сервера не ошибка теста.
    const server = createServer((c) => {
      c.on('error', () => undefined);
      c.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    expect(await waitFor(String(port), '--timeout', '5')).toBe(0);
    expect(await waitFor(`127.0.0.1:${port}`, '--timeout', '5')).toBe(0);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await waitFor(String(await freePort()), '--timeout', '1', '--interval', '0.2')).toBe(1);
    expect(await waitFor()).toBe(2);
  });

  it('10:30:11: цикл `curl; sleep` к серверу проходит с подсказкой на wait-for.mjs', () => {
    const loop =
      'for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5182/ && break; sleep 0.5; done';
    const out = hook('pre', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: loop },
      cwd: dir,
      transcript_path: transcript([prompt('сделай')]),
      session_id: `g9d-wait-${++n}`,
    });
    expect(decision(out)).toBeUndefined();
    expect(ctx(out)).toContain('[wait-for]');
    expect(ctx(out)).toContain(`${resolve(KIT).split('\\').join('/')}/tools/wait-for.mjs`);
    // Цикл со sleep, но без проверки сервера, подсказки не получает.
    const other = hook('pre', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'for f in a b; do echo $f; sleep 1; done' },
      cwd: dir,
      transcript_path: transcript([prompt('сделай')]),
      session_id: `g9d-wait-${++n}`,
    });
    expect(ctx(other)).not.toContain('[wait-for]');
  });
});

describe('F10 search-discipline: рекурсивный grep по чужому репозиторию', () => {
  const OWN = join(dir, 'own');
  const PANEL = join(dir, 'panel');
  mkdirSync(join(OWN, '.git'), { recursive: true });
  mkdirSync(join(PANEL, '.git'), { recursive: true });
  mkdirSync(join(PANEL, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(PANEL, 'apps', 'server', 'src'), { recursive: true });
  const FOREIGN = join(dir, 'foreign');
  mkdirSync(join(FOREIGN, '.git'), { recursive: true });
  mkdirSync(join(FOREIGN, 'src'), { recursive: true });
  // Git Bash пишет диск как `/c/…`.
  const msys = (p: string) =>
    p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
  const grep = (command: string) =>
    reason(
      hook('pre', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd: OWN,
        transcript_path: transcript([prompt('найди')]),
        session_id: 'kg9-search',
      }),
    );

  it.runIf(process.platform === 'win32')(
    '12:56:32: `cd /c/…; grep -rln --include … .` над node_modules — отказ',
    () => {
      const said = grep(`cd ${msys(PANEL)}; grep -rln --include='*.ts' narrowToRed .`);
      expect(said).toContain('search-discipline (grep)');
      expect(said).toContain('node_modules');
    },
  );

  it('grep -r по чужому репозиторию целиком — отказ с узкой формой; пакет или --include — проходит', () => {
    const fwd = FOREIGN.replace(/\\/g, '/');
    const said = grep(`grep -rln narrowToRed ${fwd}`);
    expect(said).toContain('outside this session');
    expect(said).toContain('--exclude-dir=node_modules');
    expect(grep(`grep -rln narrowToRed ${fwd}/src`)).toBe('');
    expect(grep(`grep -rln --include='*.ts' narrowToRed ${fwd}`)).toBe('');
    // Своя копия — не чужое дерево.
    expect(grep('grep -rln narrowToRed .')).toBe('');
  });
});
