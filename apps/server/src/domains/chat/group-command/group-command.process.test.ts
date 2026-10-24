import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { groupCommandVerdict, type GroupCommandScope } from './group-command.ts';
import { killsProcess } from './kill.ts';

/**
 * Каталог оболочки CLI (N4) и погашение процессов (N3) — журнал групп 23.10.
 */
const COPY = 'C:/work/example-worktrees/fix-PROJ-1063-e48cfb';
const SCOPE: GroupCommandScope = { worktree: COPY, branch: 'fix-PROJ-1063/x', ignored: [] };

/** Карточка группы №8 (08:18:46), дословно: ждала человека, хотя убирала своё. */
const LIVE_N4 =
  "node -e \"require('fs').unlinkSync(require('path').resolve('../.agent/tmp/combocheck/inst-docs-ui/node_modules'))\" && ls node_modules | wc -l && git worktree remove --force ../.agent/tmp/combocheck; echo \"rm $?\"; git worktree list | grep -c combocheck";

/**
 * Та же форма, но цель — отслеживаемый каталог копии рядом с подпроектом: эвристика
 * «агент мог стоять в подкаталоге» спасает только временное (`../.agent/tmp`), а
 * `../docs/old` от корня — вне копии.
 */
const LIVE_N4_TRACKED = LIVE_N4.replace(
  'git worktree remove --force ../.agent/tmp/combocheck',
  'rm -rf ../docs/old',
);

describe('каталог оболочки CLI из транскрипта (N4)', () => {
  it('живая карточка: уборка своего из подпроекта не к человеку', () => {
    const cwd = `${COPY}/inst-docs-ui`;
    expect(groupCommandVerdict(LIVE_N4, { ...SCOPE, cwd }).kind).not.toBe('danger');
  });

  it('в подпроекте копии `..` — сама копия; без каталога — от корня, вне копии', () => {
    const verdict = groupCommandVerdict(LIVE_N4_TRACKED, { ...SCOPE, cwd: `${COPY}/inst-docs-ui` });
    expect(verdict).toMatchObject({ deletes: true });
    expect(verdict.kind).not.toBe('danger');
    expect(groupCommandVerdict(LIVE_N4_TRACKED, SCOPE).kind).toBe('danger');
  });

  it('обратная запись Windows (`C:\\…\\inst-docs-ui`) — тот же каталог', () => {
    const cwd = `${COPY.replace(/\//g, '\\')}\\inst-docs-ui`;
    expect(groupCommandVerdict(LIVE_N4_TRACKED, { ...SCOPE, cwd }).kind).not.toBe('danger');
  });

  const COMMANDS = [LIVE_N4, LIVE_N4_TRACKED, 'rm -rf src', 'rm -rf .agent/tmp/x', 'rm -rf ../x'];

  it.each([
    ['вне копии', 'C:/work/other-project'],
    ['соседняя копия с общим началом имени', `${COPY}-other/inst-docs-ui`],
    ['наверх из копии', `${COPY}/inst-docs-ui/../..`],
  ])('каталог %s — каталог неизвестен: относительное удаление к человеку', (_name, cwd) => {
    // Оболочка правда стоит снаружи: `rm -rf src` оттуда снёс бы чужой `src`.
    for (const command of COMMANDS) {
      expect(groupCommandVerdict(command, { ...SCOPE, cwd }).kind, command).toBe('danger');
    }
  });

  it('относительный каталог не в счёт: решение как от корня', () => {
    for (const command of COMMANDS) {
      expect(groupCommandVerdict(command, { ...SCOPE, cwd: 'inst-docs-ui' }).kind, command).toBe(
        groupCommandVerdict(command, SCOPE).kind,
      );
    }
  });

  it('`cd` в фоновом задании каталог оболочки не меняет', () => {
    // Задание `&` — подоболочка: `rm` ниже исполняется из корня, `../docs` — вне копии.
    // Каталог оболочки известен — корень копии; без него относительное к человеку (F-29).
    const atRoot = { ...SCOPE, cwd: COPY };
    expect(groupCommandVerdict('cd inst-docs-ui & rm -rf ../docs/old', atRoot).kind).toBe('danger');
    expect(groupCommandVerdict('cd inst-docs-ui && rm -rf ../docs/old', atRoot).kind).not.toBe(
      'danger',
    );
    // Пустое задание (`& &`) не разобрать — как раньше.
    expect(groupCommandVerdict('echo a & & rm -rf src', SCOPE).kind).toBe('danger');
  });

  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  it('каталог-ссылка внутри копии, ведущая наружу, копией не считается', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-shell-cwd-'));
    made.push(root);
    const copy = join(root, 'copy');
    const outside = join(root, 'outside');
    mkdirSync(join(copy, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(copy, 'link'), 'junction');
    const scope = { worktree: copy, ignored: [] };
    // Из ссылки `rm -rf src` снёс бы `outside/src` — каталог неизвестен.
    expect(groupCommandVerdict('rm -rf ../x', { ...scope, cwd: join(copy, 'link') }).kind).toBe(
      groupCommandVerdict('rm -rf ../x', scope).kind,
    );
    // Настоящий подкаталог — свой: `../x` от `src` остаётся в копии.
    expect(groupCommandVerdict('rm -rf ../x', { ...scope, cwd: join(copy, 'src') })).toMatchObject({
      kind: 'routine',
      deletes: true,
    });
  });
});

describe('погашение процессов (N3)', () => {
  const verdict = (command: string) => groupCommandVerdict(command, SCOPE);

  it.each([
    ['taskkill //PID 51234 //F', [51234], []],
    ['taskkill /F /T /PID 51234 /PID 51235', [51234, 51235], []],
    ['kill -9 4321', [4321], []],
    ['kill -s TERM 4321 4322', [4321, 4322], []],
    ['Stop-Process -Id 4321,4322 -Force', [4321, 4322], []],
    ['npx kill-port 5173 5174', [], [5173, 5174]],
    ['fuser -k 5173/tcp', [], [5173]],
    ['netstat -ano | grep 5173; taskkill //PID 51234 //F 2>&1 | tail -2', [51234], []],
  ])('цели числом — маршрут сверит, чьи: %s', (command, pids, ports) => {
    const result = verdict(command);
    expect(result.kind).not.toBe('danger');
    expect(result).toMatchObject({ kills: { pids, ports } });
  });

  // Решение владельца 24.10 (D-1): такое человеку не уходит — маршрут прав
  // отказывает агенту с тем, как погасить своё (`groupKillRefusal`).
  it.each([
    'kill $(lsof -t -i:5173)',
    'lsof -ti:5173 | xargs kill -9',
    "for p in $(netstat -ano | grep 5173 | awk '{print $5}'); do taskkill //PID $p //F; done",
    'taskkill /IM node.exe /F',
    'pkill -f vite',
    'killall node',
    'Stop-Process -Name node',
    'kill -- -4321',
    'kill -9 -1',
    'P=child.abc; kill $P',
  ])('цель не названа числом — «неназванное», не опасное: %s', (command) => {
    const result = verdict(command);
    expect(result.kind).not.toBe('danger');
    expect(result).toMatchObject({ kills: { unnamed: true } });
  });

  it.each([
    'powershell -Command "Stop-Process -Id 4321 -Force"',
    'ssh host kill 4321',
    'node -e "process.kill(4321)"',
    'python -c "import os; os.kill(4321, 9)"',
  ])('погашение чужим языком или на другой машине — человеку: %s', (command) => {
    expect(verdict(command).kind).toBe('danger');
  });

  it.each([
    'npm run dev & P=$!; sleep 5; curl -s localhost:3000 | head -1; kill $P',
    'sleep 100 & kill $!',
    'sleep 100 & kill %1',
    'kill -0 4321 && echo alive',
    'kill -l',
    'echo "kill 4321"',
    'grep -n "taskkill" scripts/dev.mjs',
    'fuser 5173/tcp',
  ])('своё или не погашение — без целей: %s', (command) => {
    const result = verdict(command);
    expect(result.kind).not.toBe('danger');
    expect(result).not.toHaveProperty('kills');
  });

  it('распознаватель хода чата узнаёт те же погашения', () => {
    expect(killsProcess('taskkill //PID 51234 //F')).toBe(true);
    expect(killsProcess('powershell -Command "Stop-Process -Id 1"')).toBe(true);
    expect(killsProcess('grep -c "kill" log.txt')).toBe(false);
  });
});
