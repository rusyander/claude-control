import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Очередь тяжёлых шагов групп (3.2 плана экономии) живыми процессами хука, как
 * их зовёт Claude Code: вход JSON на stdin. Четыре группы гоняли гейты разом —
 * таймауты тестов и повторные полные прогоны; очередь пускает один за раз.
 */
const HOOK = resolve(__dirname, '../../../../../../tools/heavy-queue-hook.mjs');
const { isHeavy, steps, stepSignature, learn, shownCommand } = (await import(
  pathToFileURL(HOOK).href
)) as {
  isHeavy: (command: string, learned?: Map<string, number>) => boolean;
  steps: (command: string) => string[];
  stepSignature: (step: string) => string | null;
  learn: (dir: string, command: string, ms: number, now?: number) => void;
  shownCommand: (command: string) => string;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-heavyq-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  AGENTDECK_HEAVY_QUEUE_DIR: dir,
  AGENTDECK_HEAVY_POLL_MS: '50',
  ...extra,
});

const pre = (session: string, id: string, command = 'pnpm test', toolInput = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  session_id: session,
  tool_use_id: id,
  tool_input: { command, ...toolInput },
});
const post = (session: string, id: string, extra: object = {}, event = 'PostToolUse') => ({
  ...pre(session, id),
  hook_event_name: event,
  ...extra,
});

function hookSync(input: object, extra: Record<string, string> = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: env(extra),
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, ms: Date.now() - started };
}

/** Хук в фоне: промис кончается, когда хук отпустил команду. */
function hookAsync(input: object, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: env(extra),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(input));
  return new Promise<number>((done) => child.on('close', () => done(Date.now())));
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
// `.tmp` — недописанная аренда атомарной записи: под нагрузкой её видно между write и rename.
const leaseFiles = () =>
  existsSync(join(dir, 'leases'))
    ? readdirSync(join(dir, 'leases')).filter((name) => !name.endsWith('.tmp'))
    : [];
const leaseUntil = (name: string) =>
  (JSON.parse(readFileSync(join(dir, 'leases', name), 'utf8')) as { until: number }).until -
  Date.now();
/** Опыт очереди: подпись → запись. */
const learnedFile = () => {
  const root = join(dir, 'learned');
  const out: Record<string, { ms: number; n: number }> = {};
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!name.endsWith('.json')) continue;
    const entry = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
      signature: string;
      ms: number;
      n: number;
    };
    out[entry.signature] = entry;
  }
  return out;
};

/** Вызов, который шёл `ms`: CLI сообщает это в `duration_ms` (живьём 17.10). */
function ranFor(session: string, id: string, command: string, ms: number) {
  hookSync(pre(session, id, command));
  hookSync({ ...post(session, id), tool_input: { command }, duration_ms: ms });
}

describe('heavy-queue-hook: что считается тяжёлым', () => {
  it('гейт, сборка и полный прогон — тяжёлые', () => {
    for (const command of [
      'pnpm type-check && pnpm lint && pnpm test',
      'npm run build',
      'pnpm --filter @agentdeck/server test',
      'npx vitest run',
      'npx playwright test',
      'go test ./...',
      'pytest',
      './gradlew check',
      'make test',
      'node "C:/x/tools/tests-cli.mjs" run --project .',
      // X1: группа Claude зовёт прогон без --project — проект в её окружении.
      'node "C:/x/tools/tests-cli.mjs" run --group gui',
      'node "C:/x/tools/tests-cli.mjs" run --case gui:gui-001',
      'cd apps/web && tsc --noEmit',
      // Ревью A2-F4/B2-F9: подробный вывод, каталог ключом, Rust/.NET, полный шаг в цепочке.
      'go test -v ./...',
      'pytest -v',
      'python -m pytest -v',
      'pnpm -C apps/web test',
      'pnpm --dir apps/web test',
      'npm --prefix web run build',
      'cargo test',
      'dotnet test',
      'pnpm type-check && pnpm lint && pnpm test && npx vitest run a.test.ts',
      // Ревью A-F07/A-F17: раннер по пути, Rust check, монорепо-оркестраторы, uv.
      'node_modules/.bin/vitest run',
      './node_modules/.bin/tsc -p .',
      'cargo check',
      'turbo run build',
      'nx run-many -t test',
      'uv run pytest',
      'pnpm --filter x exec vitest run src/a',
      'go test ./... -run TestOne',
      // Ревью A-F10/A-F11: строка с меткой heredoc и комментарий с апострофом.
      "cat <<'EOF' > a.txt && pnpm test\nhello\nEOF",
      "# agent's gate\npnpm test && npx vitest run a.test.ts",
    ]) {
      expect(isHeavy(command), command).toBe(true);
    }
  });

  it('один файл тестов, фильтр по имени, справка и обычные команды — без очереди', () => {
    for (const command of [
      'npx vitest run src/a/a.test.ts',
      'pnpm test -- -t "одна проверка"',
      'pytest tests/test_api.py',
      'go test ./pkg/x -run TestOne',
      'npx tsc --version',
      'git status && grep -rn test src',
      'pnpm dev',
      'node tools/qa/check-help.mjs',
      'cat package.json',
      'echo "pnpm test"',
      'git commit -m "fix pnpm build"',
      // Раннер, суженный до папки или файла: в группах таких было тридцать, все < 20 с.
      'npx vitest run src/components/Sidebar 2>&1 | tail -5',
      'timeout 300 npx vitest run --project browser src/components/Cell',
      'npx eslint --fix src/pages/a/index.ts',
      'npx vitest run apps/web/src/components/Cell',
      'node -e "s.replace(\\"pnpm build\\", \\"x\\")"',
      // Ревью A-F04: имя раннера аргументом — не прогон.
      'grep -rn vitest package.json',
      'npm ls eslint',
      'which tsc',
      'pnpm why vitest',
      'cat package.json | grep eslint',
      'echo use tsc',
      'node -p "1" && rg -l jest src',
      // Ревью A-F11/A-F12: комментарий и текст для человека в кавычках.
      'git status # then pnpm test',
      'git status # later: pnpm test; pnpm build',
      'node tools/tests-cli.mjs case add --title "npm test fails"',
    ]) {
      expect(isHeavy(command), command).toBe(false);
    }
  });

  it('раннер по всему пакету и тяжёлое в кавычках у обёртки — тяжёлые', () => {
    for (const command of [
      'npx vitest run src',
      'npx vitest run ./web',
      'npx vitest run --config ./web/vitest.config.ts',
      'npx vitest run > .agent/tmp/out.log 2>&1',
      'npx eslint .',
      'node ~/.claude/tools/mustfail.mjs --base HEAD --cmd "npx vitest run src"',
      "nohup sh -c 'pnpm test > gate.log 2>&1' > /dev/null 2>&1",
      'mustfail --cmd="npx vitest run src"',
      // Ревью A-F05: пакет монорепо, его src, корень ключом, доля по номеру, `src` рядом с путём.
      'npx vitest run apps/web',
      'npx vitest run apps/server/src',
      'npx eslint apps/web',
      'pnpm vitest run apps/web',
      'npx vitest run --dir apps/web',
      'npx vitest run --shard 1/2',
      'npx vitest run src tests/unit',
      'npx eslint --ignore-pattern dist/x .',
      // Ревью A-F06: исключение из прогона — не сужение.
      'npx vitest run --exclude "**/*.browser.test.tsx"',
      'pnpm test -- --exclude "**/*.e2e.test.ts"',
      'pytest --ignore=tests/test_slow.py',
      'npx jest --testPathIgnorePatterns e2e.spec.ts',
    ]) {
      expect(isHeavy(command), command).toBe(true);
    }
  });

  it('шаги делятся вне кавычек; экранированная кавычка строку не закрывает', () => {
    expect(steps('pnpm lint && npx vitest run a.test.ts | tail -3')).toEqual([
      'pnpm lint',
      'npx vitest run a.test.ts',
      'tail -3',
    ]);
    expect(steps('mustfail --cmd "cd web && pnpm test"; echo ok')).toEqual([
      'mustfail --cmd "cd web && pnpm test"',
      'echo ok',
    ]);
    expect(steps('node -e "a(\\"x; y\\")" 2>&1 && pnpm test')).toEqual([
      'node -e "a(\\"x; y\\")" 2>&1',
      'pnpm test',
    ]);
    expect(steps("python - <<'EOF'\nrun('npm test'); x = 1\nEOF\necho done")).toEqual([
      'python - <<EOF',
      'echo done',
    ]);
    expect(steps("cat <<'END-OF-FILE' > a.txt && pnpm test\nhello\nEND-OF-FILE")).toEqual([
      'cat <<END-OF-FILE > a.txt',
      'pnpm test',
    ]);
  });

  /** Ревью A-F08/A-F13: подпись — запущенная программа, без значений ключей и учёток. */
  it('подпись: запускалка раскрывается, значение ключа интерпретатора и адрес — не скрипт', () => {
    expect(stepSignature('npx tsx scripts/seed.ts')).toBe('tsx scripts/seed.ts');
    expect(stepSignature('pnpm exec node scripts/quick.mjs')).toBe('node scripts/quick.mjs');
    expect(stepSignature('node --import tsx scripts/quick.ts')).toBe('node scripts/quick.ts');
    expect(stepSignature('docker compose up --build')).toBe('docker compose up');
    expect(stepSignature('docker compose ps')).toBe('docker compose ps');
    expect(stepSignature('pg_dump postgresql://user:s3cret@db:5432/app > dump.sql')).toBe(
      'pg_dump <address>',
    );
    expect(stepSignature('node .claude/tools/check-ticket.mjs > .agent/tmp/vitest.log 2>&1')).toBe(
      'node .claude/tools/check-ticket.mjs',
    );
  });
});

describe('heavy-queue-hook: очередь', () => {
  it('свободное место — пропуск сразу и аренда на вызов; конец команды отдаёт её', () => {
    const run = hookSync(pre('s1', 'toolu_1'));
    expect(run.code).toBe(0);
    expect(run.out).toBe('');
    expect(leaseFiles()).toEqual(['s1.toolu_1.json']);
    hookSync(post('s1', 'toolu_1'));
    expect(leaseFiles()).toEqual([]);
  });

  it('вторая группа ждёт, пока первая не закончит; провал команды тоже отдаёт место', async () => {
    hookSync(pre('s1', 'toolu_a'));
    const released = Date.now() + 1_200;
    const waiting = hookAsync(pre('s2', 'toolu_b'));
    await wait(1_200);
    expect(leaseFiles()).toEqual(['s1.toolu_a.json']);
    hookSync(post('s1', 'toolu_a', {}, 'PostToolUseFailure'));
    const passed = await waiting;
    expect(passed).toBeGreaterThanOrEqual(released);
    expect(leaseFiles()).toEqual(['s2.toolu_b.json']);
  });

  /**
   * Под нагрузкой (гейт панели гоняет веб и сервер разом) вторая группа ушла
   * без аренды: на Windows ожидающий читал аренду, которую в тот же миг
   * удалял отпускающий, и сбой уборки обрывал ожидание — команда шла мимо
   * очереди. Здесь то же разом у шести групп: каждая отпускается, пока
   * остальные опрашивают каталог.
   */
  // signal: по таймауту vitest цикл не останавливает, а `dir` к тому времени уже
  // каталог следующего теста — цикл-сирота отпускал там чужую аренду (полный прогон, 18.10).
  it('шесть групп разом: аренда по одной, ни одна не уходит без неё', async ({ signal }) => {
    const ids = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
    const exits = ids.map((id) => hookAsync(pre(`s-${id}`, `toolu_${id}`)));
    const served: string[] = [];
    let most = 0;
    for (let t = 0; t < 40_000 && served.length < ids.length && !signal.aborted; t += 20) {
      const now = leaseFiles();
      most = Math.max(most, now.length);
      const [lease] = now;
      if (now.length === 1 && lease && !served.includes(lease)) {
        served.push(lease);
        await wait(60);
        const { session, toolUseId } = JSON.parse(
          readFileSync(join(dir, 'leases', lease), 'utf8'),
        ) as { session: string; toolUseId: string };
        await hookAsync(post(session, toolUseId));
      }
      await wait(20);
    }
    await Promise.all(exits);
    expect(most).toBe(1);
    expect(served.sort()).toEqual(ids.map((id) => `s-${id}.toolu_${id}.json`));
  }, 120_000);

  /** Ревью A2-F6 / A-F09: свой билет, убранный чужим читателем, вперёд очереди не пускает. */
  it('пропавший свой билет возвращается: ожидающий ждёт дальше, а не идёт вперёд', async () => {
    hookSync(pre('s1', 'toolu_hold'));
    const waiting = hookAsync(pre('s2', 'toolu_w'), { AGENTDECK_HEAVY_MAX_WAIT_MS: '20000' });
    await wait(800);
    for (const name of readdirSync(join(dir, 'tickets'))) rmSync(join(dir, 'tickets', name));
    await wait(800);
    expect(leaseFiles()).toEqual(['s1.toolu_hold.json']);
    expect(readdirSync(join(dir, 'tickets')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    hookSync(post('s1', 'toolu_hold'));
    await waiting;
    expect(leaseFiles()).toEqual(['s2.toolu_w.json']);
  });

  it('своя аренда сессию не держит: группа идёт по шагам сама', () => {
    hookSync(pre('s1', 'toolu_bg', 'pnpm test', { run_in_background: true }));
    const run = hookSync(pre('s1', 'toolu_fg'));
    expect(run.ms).toBeLessThan(5_000);
    expect(leaseFiles().sort()).toEqual(['s1.toolu_bg.json', 's1.toolu_fg.json']);
  });

  /**
   * Отказ соседнего хука: CLI ждёт и этот хук, но потом не зовёт ни
   * `PostToolUse`, ни `PostToolUseFailure` (живьём 17.10). Аренду отдаёт
   * следующий вызов той же линии; субагент — своя линия, фон линии остаётся.
   */
  it('аренда отказанной команды уходит на следующем вызове той же линии', () => {
    hookSync(pre('s1', 'toolu_bg', 'pnpm build', { run_in_background: true }));
    hookSync(pre('s1', 'toolu_denied', 'pnpm test && git push'));
    hookSync({ ...pre('s1', 'toolu_sub', 'pnpm lint'), agent_id: 'a1' });
    expect(leaseFiles().sort()).toEqual([
      's1.toolu_bg.json',
      's1.toolu_denied.json',
      's1.toolu_sub.json',
    ]);
    hookSync(pre('s1', 'toolu_next', 'git status'));
    expect(leaseFiles().sort()).toEqual(['s1.toolu_bg.json', 's1.toolu_sub.json']);
    // Чужая сессия чужие аренды не трогает.
    hookSync(pre('s2', 'toolu_other', 'git status'));
    expect(leaseFiles().sort()).toEqual(['s1.toolu_bg.json', 's1.toolu_sub.json']);
  });

  /**
   * Группа Qwen Code: оболочка приходит под своим именем, фон — `is_background`
   * (поля сняты с живого qwen 0.25, 17.10). Без этого её гейт шёл мимо очереди.
   * Свою линию Qwen не отдаёт: вызовы хода он может вести разом.
   */
  it('оболочка Qwen Code встаёт в ту же очередь; её фон аренду концом хода не снимает', () => {
    const qwen = (id: string, event: string, toolInput = {}) => ({
      ...pre('q1', id),
      hook_event_name: event,
      tool_name: 'run_shell_command',
      tool_call_id: 'call0',
      tool_input: { command: 'pnpm test', is_background: false, ...toolInput },
    });
    hookSync(qwen('toolu_q1', 'PreToolUse'));
    expect(leaseFiles()).toEqual(['q1.toolu_q1.json']);
    hookSync(qwen('toolu_q1', 'PostToolUseFailure'));
    expect(leaseFiles()).toEqual([]);
    hookSync(qwen('toolu_q2', 'PreToolUse', { is_background: true }));
    // Фоновый срок (10 мин), а не переднего плана (2 мин с запасом).
    expect(leaseUntil('q1.toolu_q2.json')).toBeGreaterThan(300_000);
    hookSync(qwen('toolu_q2', 'PostToolUse', { is_background: true }));
    expect(leaseFiles()).toEqual(['q1.toolu_q2.json']);
    hookSync(qwen('toolu_q3', 'PreToolUse'));
    hookSync(qwen('toolu_q4', 'PreToolUse', { command: 'git status' }));
    expect(leaseFiles().sort()).toEqual(['q1.toolu_q2.json', 'q1.toolu_q3.json']);
  });

  /** Ревью A-Q2: один id вызова у двух сессий — две разные аренды. */
  it('одинаковый id вызова у двух групп — аренды не смешиваются', () => {
    hookSync({ ...pre('q1', 'call0'), tool_name: 'run_shell_command' });
    hookSync(
      { ...pre('q2', 'call0'), tool_name: 'run_shell_command' },
      { AGENTDECK_HEAVY_SLOTS: '2' },
    );
    hookSync({ ...post('q1', 'call0'), tool_name: 'run_shell_command' });
    expect(leaseFiles()).toEqual(['q2.call0.json']);
  });

  /** Ревью A2-F5/B2-F7: CLI зовёт PostToolUse при ЗАПУСКЕ фоновой команды. */
  it('конец хода фоновой команды аренду не снимает — её отдаёт срок', () => {
    hookSync(pre('s1', 'toolu_bg', 'pnpm test', { run_in_background: true }));
    hookSync({
      ...post('s1', 'toolu_bg'),
      tool_input: { command: 'pnpm test', run_in_background: true },
    });
    expect(leaseFiles()).toEqual(['s1.toolu_bg.json']);
  });

  /** Ревью B2-F8: номер убитого ожидающего достался чужому живому процессу. */
  it('билет старше самого долгого ожидания место не держит, даже с живым номером', () => {
    mkdirSync(join(dir, 'tickets'), { recursive: true });
    const dayAgo = Date.now() - 86_400_000;
    writeFileSync(
      join(dir, 'tickets', `${String(dayAgo).padStart(15, '0')}-1-old.json`),
      JSON.stringify({ pid: process.pid, session: 'gone', created: dayAgo }),
    );
    const run = hookSync(pre('s2', 'toolu_new'), { AGENTDECK_HEAVY_MAX_WAIT_MS: '6000' });
    expect(run.ms).toBeLessThan(4_000);
    expect(leaseFiles()).toEqual(['s2.toolu_new.json']);
  });

  it('секрет из строки команды в аренду не пишется', () => {
    hookSync(pre('s1', 'toolu_s', 'GITLAB_TOKEN=glpat-abc123 API_KEY=k pnpm test'));
    const lease = readFileSync(join(dir, 'leases', 's1.toolu_s.json'), 'utf8');
    expect(lease).toContain('GITLAB_TOKEN=*** API_KEY=*** pnpm test');
    expect(lease).not.toContain('glpat-abc123');
  });

  /** Ревью A-F13: заголовок, переменная строчными, значение в кавычках, учётка в адресе, ключ. */
  it('маска секретов: заголовки, учётки в адресе, ключи и переменные любого регистра', () => {
    const cases: [string, string][] = [
      ['curl -H "PRIVATE-TOKEN: glpat-xyz" https://x/api && pnpm test', 'glpat-xyz'],
      ['curl -H "Authorization: Bearer abc.def" x', 'abc.def'],
      ['npm_token=npm_secret pnpm test', 'npm_secret'],
      ['GITLAB_TOKEN="a b" pnpm test', 'a b'],
      ['DATABASE_URL=postgres://u:pw1@db/app pnpm test', 'pw1'],
      ['psql postgres://u:pw2@db/app', 'pw2'],
      ['tool --token tok123 run', 'tok123'],
    ];
    for (const [command, secret] of cases) {
      expect(shownCommand(command), command).not.toContain(secret);
    }
  });

  it('просроченная аренда (CLI убит, в правах отказано) место не держит', () => {
    mkdirSync(join(dir, 'leases'), { recursive: true });
    writeFileSync(
      join(dir, 'leases', 'gone.toolu_dead.json'),
      JSON.stringify({ session: 'gone', until: Date.now() - 1 }),
    );
    const run = hookSync(pre('s2', 'toolu_c'));
    expect(run.ms).toBeLessThan(5_000);
    expect(leaseFiles()).toEqual(['s2.toolu_c.json']);
  });

  it('срок переднего плана — таймаут Bash с запасом, фона — настройка', () => {
    hookSync(pre('s1', 'toolu_t', 'pnpm test', { timeout: 300_000 }));
    hookSync(pre('s2', 'toolu_bg', 'pnpm build', { run_in_background: true }), {
      AGENTDECK_HEAVY_BACKGROUND_MS: '900000',
      AGENTDECK_HEAVY_SLOTS: '2',
    });
    expect(leaseUntil('s1.toolu_t.json')).toBeGreaterThan(300_000);
    expect(leaseUntil('s1.toolu_t.json')).toBeLessThanOrEqual(330_000);
    expect(leaseUntil('s2.toolu_bg.json')).toBeGreaterThan(330_000);
    expect(leaseUntil('s2.toolu_bg.json')).toBeLessThanOrEqual(900_000);
  });

  it('ожидание не дольше предела: дальше команда идёт без аренды и пишет обход', () => {
    hookSync(pre('s1', 'toolu_hold'));
    const run = hookSync(pre('s2', 'toolu_late'), { AGENTDECK_HEAVY_MAX_WAIT_MS: '300' });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(5_000);
    expect(leaseFiles()).toEqual(['s1.toolu_hold.json']);
    expect(readdirSync(join(dir, 'tickets'))).toEqual([]);
    expect(readFileSync(join(dir, 'bypass.log'), 'utf8')).toMatch(
      / timeout pnpm test \| держали: s1 «pnpm test» с \d\d:\d\d до \d\d:\d\d\n$/,
    );
  });

  /** Шесть групп разом 17.10: уборка удаляла чужой недописанный файл, и сосед шёл без аренды. */
  it('уборка отметок начала не трогает чужой недописанный файл', () => {
    mkdirSync(join(dir, 'starts'), { recursive: true });
    const writing = join(dir, 'starts', 's9.toolu_other.json.4242.tmp');
    writeFileSync(writing, '{"at":');
    hookSync(pre('s1', 'toolu_mine', 'git status'));
    expect(existsSync(writing)).toBe(true);
  });

  /** Команда CLI ушла в фон по таймауту Bash: гейт шёл дальше, а аренда снималась. */
  it('команду, которую CLI сам увёл в фон, аренда держит дальше', () => {
    hookSync(pre('s1', 'toolu_moved'));
    hookSync(
      post('s1', 'toolu_moved', {
        tool_response: { backgroundTaskId: 'bash_1', timedOutAfterMs: 600_000 },
        duration_ms: 600_000,
      }),
    );
    expect(leaseFiles()).toEqual(['s1.toolu_moved.json']);
    expect(leaseUntil('s1.toolu_moved.json')).toBeGreaterThan(500_000);
    // Уведённая — уже фон: следующий вызов линии её не отдаёт.
    hookSync(pre('s1', 'toolu_after', 'git status'));
    expect(leaseFiles()).toEqual(['s1.toolu_moved.json']);
  });

  /** Три чужие аренды, которые ещё идут: занимают три места. */
  const foreignLeases = () => {
    mkdirSync(join(dir, 'leases'), { recursive: true });
    for (const id of ['a', 'b', 'c']) {
      writeFileSync(
        join(dir, 'leases', `f${id}.toolu_${id}.json`),
        JSON.stringify({
          session: `f${id}`,
          command: `pnpm test ${id}`,
          since: Date.now() - 60_000,
          until: Date.now() + 600_000,
        }),
      );
    }
  };
  const writeConfig = (value: unknown) =>
    writeFileSync(join(dir, 'config.json'), JSON.stringify(value));

  /**
   * Журнал 19.10 20:25–20:40: мест стало четыре (код и перезапуск панели), а
   * идущие группы держали два из окружения, снятого при их запуске, и стояли в
   * очереди по 10–15 минут при свободных ядрах. Число мест — из файла очереди.
   */
  it('число мест — из файла очереди, а не из окружения запуска группы', () => {
    foreignLeases();
    writeConfig({ slots: 4 });
    const run = hookSync(pre('s1', 'toolu_mine'), {
      AGENTDECK_HEAVY_SLOTS: '2',
      AGENTDECK_HEAVY_MAX_WAIT_MS: '3000',
    });
    expect(run.ms).toBeLessThan(2_500);
    expect(leaseFiles()).toContain('s1.toolu_mine.json');
    expect(existsSync(join(dir, 'bypass.log'))).toBe(false);
  });

  it('смена числа мест доходит до уже ждущей группы за один опрос', async () => {
    foreignLeases();
    writeConfig({ slots: 2 });
    const waiting = hookAsync(pre('s1', 'toolu_wait'), {
      AGENTDECK_HEAVY_SLOTS: '2',
      AGENTDECK_HEAVY_MAX_WAIT_MS: '20000',
    });
    await wait(800);
    expect(leaseFiles()).not.toContain('s1.toolu_wait.json');
    const raised = Date.now();
    writeConfig({ slots: 4 });
    const passed = await waiting;
    expect(passed - raised).toBeLessThan(5_000);
    expect(leaseFiles()).toContain('s1.toolu_wait.json');
    expect(existsSync(join(dir, 'bypass.log'))).toBe(false);
  }, 30_000);

  it('битый или пустой файл очереди — число мест из окружения', () => {
    foreignLeases();
    for (const broken of ['{', JSON.stringify({ slots: 0 }), JSON.stringify({ slots: 'x' })]) {
      writeFileSync(join(dir, 'config.json'), broken);
      const run = hookSync(pre('s1', `toolu_${broken.length}`), {
        AGENTDECK_HEAVY_SLOTS: '4',
        AGENTDECK_HEAVY_MAX_WAIT_MS: '3000',
      });
      expect(run.ms, broken).toBeLessThan(2_500);
      hookSync(post('s1', `toolu_${broken.length}`));
    }
  });

  /** Ожидающая группа прежде ничего не говорила: кто держит места и с каких пор. */
  it('состояние очереди: места, кто их держит и кто ждёт', async () => {
    foreignLeases();
    writeConfig({ slots: 3 });
    const waiting = hookAsync(pre('s9', 'toolu_w', 'pnpm build'), {
      AGENTDECK_HEAVY_MAX_WAIT_MS: '1500',
    });
    await wait(700);
    const status = spawnSync(process.execPath, [HOOK, 'status', dir], { encoding: 'utf8' });
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/3 из 3/);
    expect(status.stdout).toContain('pnpm test a');
    expect(status.stdout).toMatch(/fa .*с \d\d:\d\d/);
    expect(status.stdout).toContain('s9');
    expect(status.stdout).toContain('pnpm build');
    await waiting;
    // Ушёл по пределу — в журнале обходов те, кто держал места.
    const log = readFileSync(join(dir, 'bypass.log'), 'utf8');
    expect(log).toMatch(/ timeout pnpm build/);
    expect(log).toContain('pnpm test a');
  });

  it('лёгкая команда, чужой инструмент, нет каталога очереди, битый вход — тишина и код 0', () => {
    hookSync(pre('s1', 'toolu_hold'));
    expect(hookSync(pre('s2', 'toolu_x', 'git status')).ms).toBeLessThan(5_000);
    expect(hookSync({ ...pre('s2', 'toolu_y'), tool_name: 'Read' }).ms).toBeLessThan(5_000);
    const noDir = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(pre('s2', 'toolu_z')),
      encoding: 'utf8',
      env: { ...process.env, AGENTDECK_HEAVY_QUEUE_DIR: '' },
    });
    expect(noDir.status).toBe(0);
    const broken = spawnSync(process.execPath, [HOOK], { input: '{not json', env: env() });
    expect(broken.status).toBe(0);
    expect(leaseFiles()).toEqual(['s1.toolu_hold.json']);
  });
});

/**
 * Гейт проекта зовётся своим скриптом, имени которого очередь не знает: в группах
 * 16.10 мимо неё шло 92 % тяжёлого времени. Хук замеряет команды сам.
 */
describe('heavy-queue-hook: опыт', () => {
  const GATE = 'node .claude/tools/check-ticket.mjs 2>&1 | tail -40';
  const SIGNATURE = 'node .claude/tools/check-ticket.mjs';
  /** Ждать недолго: команда, ушедшая в очередь, краснит проверку, а не таймаут теста. */
  const WAIT_6S = { AGENTDECK_HEAVY_MAX_WAIT_MS: '6000' };

  it('скрипт, шедший дольше порога, в следующий раз встаёт в очередь — из любой копии', () => {
    expect(isHeavy(GATE)).toBe(false);
    ranFor('s1', 'toolu_g1', GATE, 200_000);
    expect(Object.keys(learnedFile())).toEqual([SIGNATURE]);
    hookSync(pre('s1', 'toolu_hold'));
    const run = hookSync(
      pre('s2', 'toolu_g2', 'node /c/work/x-trees/y/.claude/tools/check-ticket.mjs'),
      { AGENTDECK_HEAVY_MAX_WAIT_MS: '800' },
    );
    expect(run.ms).toBeGreaterThanOrEqual(800);
    expect(leaseFiles()).toEqual(['s1.toolu_hold.json']);
  });

  it('короткий скрипт не запоминается; ставший быстрым — уходит из очереди', () => {
    ranFor('s1', 'toolu_q', 'node tools/check-lf.mjs', 3_000);
    expect(learnedFile()).toEqual({});
    ranFor('s1', 'toolu_g1', GATE, 200_000);
    ranFor('s1', 'toolu_g2', GATE, 5_000);
    ranFor('s1', 'toolu_g3', GATE, 5_000);
    expect(learnedFile()[SIGNATURE]?.ms).toBeLessThan(90_000);
    hookSync(pre('s1', 'toolu_hold'));
    expect(hookSync(pre('s2', 'toolu_g4', GATE), WAIT_6S).ms).toBeLessThan(4_000);
  });

  /**
   * Ревью A-F02: отметка начала ставилась до ожидания, и время в очереди шло в
   * длительность — под нагрузкой гейт, ставший быстрым, из очереди не уходил.
   * CLI сообщает время самой команды; ожидание в него не входит.
   */
  it('время в очереди длительностью команды не считается', async () => {
    ranFor('s1', 'toolu_g1', GATE, 200_000);
    hookSync(pre('s9', 'toolu_hold'));
    const waiting = hookAsync(pre('s1', 'toolu_g2', GATE), WAIT_6S);
    await wait(1_500);
    hookSync(post('s9', 'toolu_hold'));
    await waiting;
    hookSync({ ...post('s1', 'toolu_g2'), tool_input: { command: GATE }, duration_ms: 0 });
    expect(learnedFile()[SIGNATURE]?.ms).toBe(100_000);
  });

  /** Qwen Code длительность не сообщает: запасной путь — отметка, поставленная ПОСЛЕ ожидания. */
  it('без длительности от CLI замер идёт от конца ожидания, а не от начала', async () => {
    const qwen = (id: string, event: string) => ({
      ...pre('q1', id, GATE),
      hook_event_name: event,
      tool_name: 'run_shell_command',
    });
    learn(dir, GATE, 200_000);
    hookSync(pre('s9', 'toolu_hold'));
    const waiting = hookAsync(qwen('toolu_g', 'PreToolUse'), WAIT_6S);
    // Три секунды ожидания: отметка до очереди дала бы среднее ≥ 101,5 с.
    await wait(3_000);
    hookSync(post('s9', 'toolu_hold'));
    await waiting;
    hookSync(qwen('toolu_g', 'PostToolUse'));
    expect(learnedFile()[SIGNATURE]?.ms).toBeLessThan(101_000);
  });

  it('длительность команды с раннером, ожиданием или фоном соседним шагам не приписывается', () => {
    ranFor('s1', 'toolu_a', 'npx prettier --write a.ts && npx vitest run a.test.ts', 200_000);
    ranFor('s1', 'toolu_b', 'node server.mjs & sleep 120', 200_000);
    ranFor('s1', 'toolu_c', 'for i in 1 2 3; do node poll.mjs; done', 200_000);
    expect(learnedFile()).toEqual({});
    // Ревью A-F07: «for» в имени скрипта и раннер в имени журнала — не ожидание и не раннер.
    ranFor('s1', 'toolu_d', 'node scripts/check-for-leaks.mjs', 200_000);
    ranFor('s1', 'toolu_e', 'node tools/run-eslint.mjs > .agent/tmp/vitest.log 2>&1', 200_000);
    expect(Object.keys(learnedFile()).sort()).toEqual([
      'node scripts/check-for-leaks.mjs',
      'node tools/run-eslint.mjs',
    ]);
  });

  it('опыт старше месяца забывается', () => {
    learn(dir, GATE, 600_000, Date.now() - 31 * 86_400_000);
    hookSync(pre('s1', 'toolu_hold'));
    expect(hookSync(pre('s2', 'toolu_g', GATE), WAIT_6S).ms).toBeLessThan(4_000);
  });

  it('фоновая аренда выученного гейта — по его длительности с запасом', () => {
    ranFor('s1', 'toolu_g1', GATE, 1_200_000);
    hookSync(pre('s1', 'toolu_bg', GATE, { run_in_background: true }));
    expect(leaseUntil('s1.toolu_bg.json')).toBeGreaterThan(1_400_000);
    expect(leaseUntil('s1.toolu_bg.json')).toBeLessThanOrEqual(1_510_000);
  });

  /** Ревью A-F03: два конца разом прежде переписывали общий файл — выживал последний. */
  it('опыт разных команд, записанный разом, не теряется', async () => {
    const gates = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `node tools/gate-${n}.mjs`);
    await Promise.all(
      gates.map((command, i) =>
        hookAsync({
          ...post(`s${i}`, `toolu_${i}`),
          tool_input: { command },
          duration_ms: 200_000,
        }),
      ),
    );
    expect(Object.keys(learnedFile()).sort()).toEqual(gates);
  });

  /**
   * Ревью A-F01: уведённая в фон команда не кончилась — прошедшее время лишь нижняя
   * граница. Она не тянет вниз известный гейт, не заводит опыт без долгого таймаута
   * (dev-сервер), и аренда после неё — не короче запасного фонового срока.
   */
  it('уведённая в фон команда: опыт только вверх, аренда не короче запасной', () => {
    const moved = (id: string, command: string, timeout?: number) =>
      hookSync({
        ...post('s1', id),
        tool_input: { command, ...(timeout ? { timeout } : {}) },
        tool_response: { backgroundTaskId: 'bash_1', timedOutAfterMs: timeout ?? 120_000 },
        duration_ms: timeout ?? 120_000,
      });
    // Неизвестный гейт без долгого таймаута: опыта нет, срок — запасной.
    hookSync(pre('s1', 'toolu_m0', 'pnpm test && node tools/gate.mjs'));
    moved('toolu_m0', 'pnpm test && node tools/gate.mjs');
    expect(learnedFile()).toEqual({});
    expect(leaseUntil('s1.toolu_m0.json')).toBeGreaterThan(590_000);
    // Dev-сервер, уведённый за две минуты, тяжёлым не становится.
    moved('toolu_m1', 'npm run dev');
    expect(learnedFile()).toEqual({});
    // Известный гейт 720 с: уведённый на второй минуте прогон его не уменьшает.
    ranFor('s1', 'toolu_g', GATE, 720_000);
    moved('toolu_m2', GATE);
    expect(learnedFile()[SIGNATURE]?.ms).toBe(720_000);
    // Агент просил долгий таймаут — это гейт: опыт заводится от нижней границы.
    moved('toolu_m3', 'node tools/long-check.mjs', 600_000);
    expect(learnedFile()['node tools/long-check.mjs']?.ms).toBe(600_000);
    // Известный короткий гейт ушёл в фон — он идёт дольше опыта: срок не короче запасного.
    ranFor('s2', 'toolu_s', 'node tools/short-check.mjs', 100_000);
    hookSync(pre('s1', 'toolu_m4', 'node tools/short-check.mjs'));
    moved('toolu_m4', 'node tools/short-check.mjs');
    expect(leaseFiles()).toContain('s1.toolu_m4.json');
    expect(leaseUntil('s1.toolu_m4.json')).toBeGreaterThan(590_000);
  });

  /** Ревью A-F09: сбой записи опыта не отнимает у уведённой команды фоновый срок. */
  it('сбой записи опыта аренду уведённой команды не укорачивает', () => {
    // Свой выученный скрипт: аренду берёт по опыту, и замер опыт обязан записать.
    // Таймаут 5 мин: срок переднего плана (5,5 мин) короче запасного фонового (10).
    const gate = { command: 'node tools/gate.mjs', timeout: 300_000 };
    learn(dir, gate.command, 200_000);
    hookSync({ ...pre('s1', 'toolu_m'), tool_input: gate });
    expect(leaseFiles()).toEqual(['s1.toolu_m.json']);
    rmSync(join(dir, 'learned'), { recursive: true, force: true });
    writeFileSync(join(dir, 'learned'), 'not a directory');
    const done = hookSync(
      post('s1', 'toolu_m', {
        tool_input: gate,
        tool_response: { backgroundTaskId: 'bash_1', timedOutAfterMs: 300_000 },
        duration_ms: 300_000,
      }),
    );
    expect(done.code).toBe(0);
    expect(leaseUntil('s1.toolu_m.json')).toBeGreaterThan(590_000);
  });
});
