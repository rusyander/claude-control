import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { DeferredAskRecord } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import type { OwnerRow } from '../../domains/chat/group-process-owner.ts';
import type { ServerContext } from '../../context.ts';
import { deferredAsksOf } from '../../routes/chat/deferred-routes/deferred-store.ts';
import { wireDeferredAsks } from './deferred-wiring.ts';
import { rejudgeGroupAsk, type RejudgeDeps } from './rejudge.ts';

/**
 * Повторный суд ждущей записи группы при старте (D-1, 24.10): настоящий стор
 * панели и настоящий транскрипт копии во временной папке; подменены только
 * снимок процессов и держатели портов — граница ОС.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';
const filetime = (ms: number): bigint => BigInt(ms + 11_644_473_600_000) * 10_000n;
const LAUNCHED = '(npx vite --port 5284 --strictPort &)';
const STUB = `bash.exe -c "source /c/snap.sh && eval '${LAUNCHED}' < /dev/null && pwd -P"`;

/** Сирота группы: заглушка bash (CLI ушёл) → vite на :5284; 200 — dev-сервер владельца. */
const t = Date.now() - 10 * 60_000;
const TABLE: OwnerRow[] = [
  { pid: 500, ppid: 4, created: filetime(t), command: STUB },
  { pid: 501, ppid: 500, created: filetime(t + 1000), command: 'node vite.js --port 5284' },
  { pid: 200, ppid: 7, created: filetime(t - 60_000), command: 'node vite.js --port 5178' },
  { pid: 7, ppid: 0, created: filetime(t - 120_000), command: 'WindowsTerminal.exe' },
];
const HOLDERS: Record<number, number[]> = { 5284: [501], 5178: [200] };

function setup(transcript: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'cc-rejudge-'));
  dirs.push(root);
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: join(root, 'repo'),
    createdAt: '2026-10-24T10:00:00.000Z',
    request: { allowEdits: true },
    groups: [
      { index: 1, title: 'g', status: 'awaiting', chatId: 'group-chat', branch: 'fix-PROJ-1/x' },
    ],
  } as unknown as SplitPlanRecord);
  store.setChatLink('group-chat', {
    parentChatId: 'parent',
    groupIndex: 1,
    branch: 'fix-PROJ-1/x',
    createdAt: '2026-10-24T10:00:00.000Z',
  });
  const projects = join(root, 'projects');
  mkdirSync(join(projects, 'C--copy'), { recursive: true });
  writeFileSync(join(projects, 'C--copy', 'sess-1.jsonl'), `${transcript.join('\n')}\n`);
  const deps: RejudgeDeps = {
    source: store,
    projectsDir: projects,
    guardedPatterns: () => [],
    allowedTools: () => new Set(),
    guarded: () => false,
    facts: {
      readTable: async () => TABLE,
      portHolders: (port) => HOLDERS[port] ?? [],
      platform: 'win32',
    },
    worktree: async (group) => ({
      ...group,
      worktree: COPY,
      ownBranch: 'fix-PROJ-1/x',
      ignored: [],
    }),
  };
  return { deps, root, appData, projects, store };
}

const callLine = (command: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });

function waiting(command: string, extra: Partial<DeferredAskRecord> = {}): DeferredAskRecord {
  return {
    id: 'D-1',
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'group', parentChatId: 'parent', groupIndex: 1 },
    runKeys: ['group-chat', 'sess-1'],
    toolName: 'Bash',
    input: { command },
    hash: 'h',
    reason: "the group's permission rows send this call to the human",
    reasonCode: 'group-rows',
    askedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    cwd: COPY,
    source: {},
    ...extra,
  };
}

/** Дословная команда D-1 (24.10 16:10Z): своя vite на :5284 по номеру из netstat. */
const D1 = `for p in $(netstat -ano | grep ":5284 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done; netstat -ano | grep -c ":5284 .*LISTENING"`;

describe('rejudgeGroupAsk', () => {
  it('D-1: своя сирота на порту (запуск записан в копии) — разрешить', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    expect(await rejudgeGroupAsk(waiting(D1), deps)).toEqual({ behavior: 'allow' });
  });

  it('та же команда без записи запуска — отказ агенту с подписью процесса', async () => {
    const { deps } = setup([callLine('npm run build')]);
    const decision = await rejudgeGroupAsk(waiting(D1), deps);
    expect(decision?.behavior).toBe('deny');
    expect(decision?.message).toContain('port 5284 held by pid 501 (node vite.js --port 5284)');
  });

  it('порт владельца — отказ; неназванная цель — отказ с тем, как назвать', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    const owner = await rejudgeGroupAsk(waiting('npx kill-port 5178'), deps);
    expect(owner).toMatchObject({ behavior: 'deny' });
    expect(owner?.message).toContain('port 5178 held by pid 200');
    const unnamed = await rejudgeGroupAsk(waiting('pkill -f vite'), deps);
    expect(unnamed?.message).toContain('does not name by number');
  });

  it('порт без держателя — разрешить: гасить нечего', async () => {
    const { deps } = setup();
    expect(await rejudgeGroupAsk(waiting('npx kill-port 5999'), deps)).toEqual({
      behavior: 'allow',
    });
  });

  it('не погашение, защита бэкенда, чужая причина, не группа — по-прежнему человеку', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    expect(await rejudgeGroupAsk(waiting('psql -c "DROP TABLE users"'), deps)).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting(D1), { ...deps, guarded: () => true })).toBeUndefined();
    expect(
      await rejudgeGroupAsk(waiting(D1, { reasonCode: 'backend-guard' }), deps),
    ).toBeUndefined();
    expect(
      await rejudgeGroupAsk(waiting(D1, { scope: { kind: 'chat', chatKeys: ['c'] } }), deps),
    ).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting(D1, { state: 'allowed' }), deps)).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting(D1, { runKeys: ['stranger'] }), deps)).toBeUndefined();
  });

  it('D-3: не погашение, что строки группы теперь пускают сами, — разрешить; git и удаление — нет', async () => {
    const { deps } = setup();
    const D3 = [
      'export MSYS_NO_PATHCONV=1',
      'CID=$(docker create --label claude.ephemeral=1 -u 1000:1000 -w /src/inst-config golang:1.25 sleep 600 2>&1 | tail -1)',
      'docker start "$CID" >/dev/null',
      'docker exec "$CID" go test ./internal/store -v 2>&1 | tail -20; docker rm -f "$CID" >/dev/null',
    ].join('\n');
    expect(await rejudgeGroupAsk(waiting(D3), deps)).toEqual({ behavior: 'allow' });
    expect(await rejudgeGroupAsk(waiting('docker exec "$CID" rm -rf /src'), deps)).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting('git push origin HEAD'), deps)).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting('rm -rf /c/Users/me'), deps)).toBeUndefined();
  });

  it('погашение рядом с затиранием или пушем — живому маршруту', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    expect(
      await rejudgeGroupAsk(waiting(`npx kill-port 5284 && git reset --hard HEAD~1`), deps),
    ).toBeUndefined();
  });
});

/**
 * git над копией (D-4, 25.10): карточка группы с `cd ..; git -C .. add …` из
 * подпапки ждала человека, пока группа стояла посреди перебазирования. При старте
 * панели она решается сама — отказ агенту с тем, где пошёл бы git. Каталог оболочки
 * — из настоящего транскрипта (запись вызова с `cwd`), как у живого маршрута.
 */
describe('rejudgeGroupAsk — git над копией (D-4)', () => {
  const SUB = `${COPY}/inst-docs-ui`;
  const LIVE =
    'cd .. 2>/dev/null; git -C .. add inst-docs-ui/src/app.tsx && git -C .. rebase --continue';
  const norm = (text: string | undefined): string => (text ?? '').replace(/\\/g, '/').toLowerCase();
  /** Запись вызова в транскрипте: CLI пишет `cwd` оболочки в каждую запись. */
  const callIn = (toolUseId: string, cwd: string, command: string) =>
    JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId: 'sess-1',
      message: {
        id: `msg-${toolUseId}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
      },
    });

  it('два подъёма из подпапки — отказ, названы оболочка, каталог git и копия', async () => {
    const { deps } = setup([callIn('toolu_d4', SUB, LIVE)]);
    const decision = await rejudgeGroupAsk(waiting(LIVE, { toolUseId: 'toolu_d4' }), deps);
    expect(decision?.behavior).toBe('deny');
    const text = norm(decision?.message);
    expect(text).toContain(`your shell is in ${norm(SUB)}`);
    expect(text).toContain('git would run in c:/work/shop-worktrees,');
    expect(text).toContain(`contains your copy ${norm(COPY)}`);
  });

  it('один подъём из подпапки — не этот отказ: git остаётся вызовом живого маршрута', async () => {
    const command = 'git -C .. add inst-docs-ui/src/app.tsx && git -C .. rebase --continue';
    const { deps } = setup([callIn('toolu_one', SUB, command)]);
    expect(
      await rejudgeGroupAsk(waiting(command, { toolUseId: 'toolu_one' }), deps),
    ).toBeUndefined();
  });

  it('запись вызова без каталога в транскрипте — корень угадан: отказ с тем, от чего считался `..`', async () => {
    const { deps } = setup([callLine(LIVE)]);
    const decision = await rejudgeGroupAsk(
      waiting('git -C .. add x', { toolUseId: 'toolu_none' }),
      deps,
    );
    expect(decision?.behavior).toBe('deny');
    expect(decision?.message).toContain("could not read your shell's directory for this call");
  });

  /**
   * D-6 (25.10): коммит в своей копии из подпапки (`git -C .. add/commit/log/status`)
   * ждал человека — при старте git целиком оставался живому маршруту. git только
   * из локальных записей и чтений в своей копии судят строки группы здесь же.
   */
  const D6 = [
    "git -C .. add inst-docs-ui && git -C .. commit -q -F - <<'EOF'",
    'fix(inst-docs-ui): сверка жирных ячеек',
    'EOF',
    'echo rc=$?; git -C .. log --oneline -2; git -C .. status --short | head',
  ].join('\n');

  it('D-6: коммит в своей копии из подпапки — разрешить', async () => {
    const { deps } = setup([callIn('toolu_d6', SUB, D6)]);
    expect(await rejudgeGroupAsk(waiting(D6, { toolUseId: 'toolu_d6' }), deps)).toEqual({
      behavior: 'allow',
    });
  });

  it('git с сетью, догоном, сменой ветки или затиранием — по-прежнему живому маршруту', async () => {
    for (const tail of [
      'git -C .. push',
      'git -C .. pull',
      'git -C .. fetch origin',
      'git -C .. rebase origin/main',
      'git -C .. merge origin/main',
      'git -C .. checkout -b other',
      'git -C .. stash',
      'git -C .. tag v1',
      'git -C .. branch -f x',
      'git -C .. reset --hard',
    ]) {
      const command = `git -C .. add x && git -C .. commit -qm x && ${tail}`;
      const { deps } = setup([callIn('toolu_mix', SUB, command)]);
      expect(
        await rejudgeGroupAsk(waiting(command, { toolUseId: 'toolu_mix' }), deps),
        tail,
      ).toBeUndefined();
    }
  });

  /**
   * D-7 (25.10): точка соединения в рабочей папке копии на `node_modules` копии и
   * проверка во второй рабочей копии; git — только `diff --stat`, чтение.
   */
  const D7 = [
    'W=.agent/tmp/vf-wt',
    'git -C $W diff --stat | tail -1',
    'cmd //c mklink /J "$(cygpath -w $W/inst-docs-ui/node_modules)" "$(cygpath -w inst-docs-ui/node_modules)" >/dev/null',
    'node $W/inst-docs-ui/scripts/check_content.mjs > .agent/tmp/vf-p0.log 2>&1',
    'echo "p0 rc=$?"; tail -2 .agent/tmp/vf-p0.log',
  ].join('; ');

  it('D-7: ссылка в копии на каталог копии и чтение git — разрешить; цель вне копии — нет', async () => {
    const { deps } = setup([callIn('toolu_d7', COPY, D7)]);
    expect(await rejudgeGroupAsk(waiting(D7, { toolUseId: 'toolu_d7' }), deps)).toEqual({
      behavior: 'allow',
    });
    const outside = D7.replace('"$(cygpath -w inst-docs-ui/node_modules)"', 'C:/work');
    const other = setup([callIn('toolu_d7o', COPY, outside)]);
    expect(
      await rejudgeGroupAsk(waiting(outside, { toolUseId: 'toolu_d7o' }), other.deps),
    ).toBeUndefined();
  });

  it('git, которого разбор не дошёл, — живому маршруту: `git` в тексте без суда', async () => {
    // Слово `git` в тексте, которое разбор не судил как вызов git, — не доказано, что git только свой.
    const command = 'git -C .. add x && echo "git push"';
    const { deps } = setup([callIn('toolu_txt', SUB, command)]);
    expect(
      await rejudgeGroupAsk(waiting(command, { toolUseId: 'toolu_txt' }), deps),
    ).toBeUndefined();
  });

  it('обход при старте: ждущая карточка становится «denied» с пометкой auto и той же причиной', async () => {
    const { deps, root, appData, store } = setup([callIn('toolu_boot', SUB, LIVE)]);
    const ctx = { store, location: { paths: { root, appData } } } as unknown as ServerContext;
    const card = deferredAsksOf(ctx).ask({
      scope: { kind: 'group', parentChatId: 'parent', groupIndex: 1 },
      runKeys: ['group-chat', 'sess-1'],
      toolName: 'Bash',
      input: { command: LIVE },
      toolUseId: 'toolu_boot',
      reason: "the group's permission rows send this call to the human",
      reasonCode: 'group-rows',
      cwd: COPY,
    }).record;
    expect(card.state).toBe('waiting');
    const told: string[] = [];
    const wiring = wireDeferredAsks({
      ctx,
      runs: {
        isRunning: () => false,
        describe: () => undefined,
        describeIdle: () => undefined,
        start: () => true,
      },
      resumeGroup: (_group: SplitPlanGroupRecord, prompt, onSent, render) => {
        told.push(render ? (render() ?? '') : prompt);
        onSent?.();
        return 'sent';
      },
      rejudge: (record) => rejudgeGroupAsk(record, deps),
      setTimer: () => undefined,
      setInterval: () => undefined,
    });
    await wiring.reDrive();
    const decided = deferredAsksOf(ctx).get(card.id);
    expect(decided).toMatchObject({ state: 'denied', decidedVia: 'auto' });
    expect(norm(decided?.message)).toContain('git would run in c:/work/shop-worktrees,');
    expect(norm(told.join('\n'))).toContain(`your shell is in ${norm(SUB)}`);
  });
});

/**
 * D-8 и D-9 (25.10, разговоры g9 копии GOR-55): карточки ждали человека ночь.
 * D-8 — уборка своих снимков в `.agent/` и погашение двух своих dev-серверов по
 * номерам из своего же `netstat`; при старте панели процессов уже нет. D-9 —
 * распаковка дерева базового коммита своей копии в `.agent/tmp` и проверка из
 * него; запись вызова лежит дальше хвоста транскрипта.
 */
describe('rejudgeGroupAsk — D-8 и D-9', () => {
  const T0 = Date.parse('2026-10-25T22:46:05.208Z');
  const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
  const callAt = (id: string, command: string, offsetMs: number, cwd = COPY) =>
    JSON.stringify({
      type: 'assistant',
      cwd,
      timestamp: at(offsetMs),
      message: {
        id: `msg-${id}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    });
  const resultAt = (id: string, text: string, offsetMs: number, cwd = COPY) =>
    JSON.stringify({
      type: 'user',
      cwd,
      timestamp: at(offsetMs),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    });

  /** Дословная команда D-8 (25.10 22:49Z), каталог копии — тестовый. */
  const D8 = [
    `W=${COPY}`,
    'rm $W/.agent/screenshots/before-after/gor55-e6/*_BEFORE.png',
    'taskkill //PID 6968 //T //F',
    'taskkill //PID 30548 //T //F',
    'netstat -ano | grep LISTENING | grep ":518" || echo "ports free"',
  ].join('; ');
  const NETSTAT = [
    '  TCP    [::1]:5173             [::]:0                 LISTENING       1111',
    '  TCP    [::1]:5180             [::]:0                 LISTENING       6968',
    '  TCP    [::1]:5181             [::]:0                 LISTENING       30548',
  ].join('\n');
  const LAUNCHES = [
    callAt('t1', 'npm --prefix /c/work/x/inst-admin-ui run dev -- --port 5180 --strictPort', 0),
    callAt('t2', 'npm --prefix inst-admin-ui run dev -- --port 5181 --strictPort', 1_000),
  ];
  const NETSTAT_CALL = [
    callAt('t3', 'netstat -ano | grep LISTENING | grep ":51"', 160_000),
    resultAt('t3', NETSTAT, 161_000),
  ];

  it('D-8: свои снимки в `.agent/` и номера из своего netstat (процессов уже нет) — разрешить', async () => {
    const { deps } = setup([...LAUNCHES, ...NETSTAT_CALL, callAt('toolu_d8', D8, 200_000)]);
    expect(await rejudgeGroupAsk(waiting(D8, { toolUseId: 'toolu_d8' }), deps)).toEqual({
      behavior: 'allow',
    });
  });

  it('D-8 без печати номеров разговором — отказ агенту: номер не доказан своим', async () => {
    const { deps } = setup([...LAUNCHES, callAt('toolu_d8', D8, 200_000)]);
    const decision = await rejudgeGroupAsk(waiting(D8, { toolUseId: 'toolu_d8' }), deps);
    expect(decision?.behavior).toBe('deny');
    expect(decision?.message).toContain('6968');
  });

  it('D-8: номер из netstat занят теперь чужим процессом (создан позже печати) — отказ', async () => {
    const { deps } = setup([...LAUNCHES, ...NETSTAT_CALL, callAt('toolu_d8', D8, 200_000)]);
    const reused: OwnerRow = { pid: 6968, ppid: 7, created: filetime(T0 + 3_600_000) };
    const facts = { ...deps.facts!, readTable: async () => [...TABLE, reused] };
    const decision = await rejudgeGroupAsk(waiting(D8, { toolUseId: 'toolu_d8' }), {
      ...deps,
      facts,
    });
    expect(decision?.behavior).toBe('deny');
  });

  describe('D-9 — настоящий git', () => {
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    /** Копия с коммитом; `link` — в дереве коммита ссылка (режим 120000). */
    function repo(link = false): string {
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rejudge-d9-')));
      dirs.push(dir);
      git(dir, 'init', '-q');
      mkdirSync(join(dir, 'inst-docs-ui', 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'inst-docs-ui', 'scripts', 'check_content.mjs'), 'console.log(1)\n');
      git(dir, 'add', '.');
      if (link) {
        const blob = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], {
          input: '../../..',
          encoding: 'utf8',
        }).trim();
        git(dir, 'update-index', '--add', '--cacheinfo', `120000,${blob},inst-docs-ui/out`);
      }
      git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
      return dir;
    }
    const d9 = (rev: string, into = '.agent/tmp/review-gor55/base-tree') =>
      [
        `mkdir -p ${into} && git archive ${rev} inst-docs-ui | tar -x -C ${into}`,
        `node ${into}/inst-docs-ui/scripts/check_content.mjs > .agent/tmp/review-gor55/c.log 2>&1; echo "exit $?"`,
      ].join(' && ');
    /**
     * Отказ «ждёт человека» лёг результатом вызова, дальше — ночь работы группы в
     * другом каталоге: ~800 КБ записей, вызов уходит из хвоста 512 КБ, как у D-9.
     */
    const later = Array.from({ length: 8 }, (_, index) =>
      JSON.stringify({
        type: 'user',
        cwd: 'C:/work/elsewhere',
        timestamp: at(60_000 + index),
        message: { role: 'user', content: `${'x'.repeat(100_000)} ${index}` },
      }),
    );
    const judge = async (dir: string, command: string) => {
      const { deps } = setup([
        callAt('toolu_d9', command, 0, dir),
        resultAt('toolu_d9', 'Waiting for the human: D-9', 1_000, dir),
        ...later,
      ]);
      const placed: RejudgeDeps = {
        ...deps,
        worktree: async (group) => ({ ...group, worktree: dir, ownBranch: 'fix-PROJ-1/x' }),
      };
      return rejudgeGroupAsk(waiting(command, { toolUseId: 'toolu_d9', cwd: dir }), placed);
    };

    it('D-9: распаковка своего коммита без ссылок в `.agent/tmp` и проверка из неё — разрешить', async () => {
      const dir = repo();
      const rev = git(dir, 'rev-parse', '--short=9', 'HEAD');
      expect(await judge(dir, d9(rev))).toEqual({ behavior: 'allow' });
    });

    it('в дереве коммита ссылка, или распаковка вне копии — по-прежнему человеку', async () => {
      const linked = repo(true);
      expect(await judge(linked, d9(git(linked, 'rev-parse', 'HEAD')))).toBeUndefined();
      const dir = repo();
      const rev = git(dir, 'rev-parse', 'HEAD');
      expect(await judge(dir, d9(rev, '../outside'))).toBeUndefined();
      expect(await judge(dir, `git archive -o ../x.tar ${rev}`)).toBeUndefined();
    });
  });
});
