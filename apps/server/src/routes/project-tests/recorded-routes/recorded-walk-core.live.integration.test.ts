import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeSecretValue } from '../../../domains/project-tests/env-secrets/env-secrets.ts';
import { declareSecret, saveEnvironment } from '../../../domains/project-tests/library/library.ts';

/**
 * Шов панель → ядро у прохода по стенду (Z11 R3 ↔ Z10 R2, W3-D F2): настоящий маршрут
 * `/api/project-tests/recorded/walk` настоящей панели одноразового стенда → настоящий порт
 * прохода (`createCoreWalkPort` → `/v1/estimate`) → НАСТОЯЩЕЕ ядро со своим временным домом.
 * Панель называет модели имена доступов окружения; ядро корни задачи берёт из своей оценки
 * (`task.created.repos`, как `walk-tools.rootsOf`) и по ним само читает имена и значения —
 * кодом ядра `adapters/browser/stand-secrets.ts`, отдельным процессом над тем же каталогом
 * данных панели, что у ядра стенда (`AGENTDECK_PANEL_DATA`).
 *
 * Доказывается: имена в задании — ровно доступы выбранного окружения; ядро по корням своей
 * задачи отдаёт значение ровно этого имени на адресе его окружения, а чужое имя, чужой адрес и
 * имя без значения — отказ с кодом; значение не лежит ни в одном файле ядра и не печатается.
 * Модельная сессия прохода не запускается здесь: её путь (CLI + Chromium + маска) — в
 * `apps/core/src/conductor/model-tools/walk.live.integration.test.ts`.
 */
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const STAND = pathToFileURL(join(REPO, 'tools/qa/throwaway-stand.mjs')).href;
const STAND_SECRETS = pathToFileURL(
  join(REPO, 'apps/core/src/adapters/browser/stand-secrets.ts'),
).href;
const WALK_TOOLS = pathToFileURL(
  join(REPO, 'apps/core/src/conductor/model-tools/walk-tools.ts'),
).href;
const MARKER = `mk${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const OTHER_MARKER = `ot${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const STAND_ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://127.0.0.1:4174';
const INERT_CLI = `if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
process.stderr.write('inert claude of the throwaway stand\\n');
process.exit(1);
`;

interface Stand {
  root: string;
  cfg: string;
  coreHome: string;
  api(path: string, init?: object): Promise<{ status: number; body: unknown }>;
  log(): string;
  coreLog(): string;
  stop(): Promise<void>;
}

interface Read {
  name: string;
  url: string;
  refused?: string;
  environmentId?: string;
  /** Значение совпало с заведённым — само значение из процесса не выходит. */
  matches?: string;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return [];
    return st.isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * Код ядра (`createStandSecrets`) отдельным процессом: импорт через границу процесса, не графа.
 * Корни задачи считает само ядро (`projectRootsOf` — те же, что у инструмента прохода) по строке
 * `task.created`: тест не повторяет их правило своим кодом.
 */
function coreReads(
  panelData: string,
  created: Record<string, unknown>,
  asks: Array<[string, string]>,
): { roots: string[]; reads: Read[] } {
  const script = `
const { createStandSecrets } = await import(${JSON.stringify(STAND_SECRETS)});
const { projectRootsOf } = await import(${JSON.stringify(WALK_TOOLS)});
const secrets = createStandSecrets(process.env.PANEL_DATA);
const roots = projectRootsOf(JSON.parse(process.env.CREATED));
const known = { [process.env.M1]: 'MARKER', [process.env.M2]: 'OTHER_MARKER' };
const out = JSON.parse(process.env.ASKS).map(([name, url]) => {
  const got = secrets.read(roots, name, url);
  return 'refused' in got
    ? { name, url, refused: got.refused }
    : { name, url, environmentId: got.environmentId, matches: known[got.value] ?? 'unknown' };
});
console.log(JSON.stringify({ roots, reads: out }));
`;
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    {
      cwd: join(REPO, 'apps/core'),
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        PANEL_DATA: panelData,
        CREATED: JSON.stringify(created),
        ASKS: JSON.stringify(asks),
        M1: MARKER,
        M2: OTHER_MARKER,
      },
    },
  );
  return JSON.parse(out.trim().split('\n').pop()!) as { roots: string[]; reads: Read[] };
}

// Один стенд на файл: оба блока ниже идут по нему. Подпапка — отдельным блоком, чтобы кейс шва
// панель→ядро (путь первого блока) не краснел чужим дефектом ядра.
let stand: Stand;
let project = '';
let panelData = '';
let bound = '';
let other = '';
let walk: { status: number; body: unknown };

beforeAll(async () => {
  const { startStand } = (await import(STAND)) as {
    startStand(options: object): Promise<Stand>;
  };
  // `claude` стенда — немой: предпроверка оценки видит CLI, а сессия, если её откроет запуск,
  // сразу выходит — ни модели, ни сети (настоящий CLI в одноразовом стенде запрещён).
  stand = await startStand({
    label: 'recorded-walk',
    web: false,
    core: true,
    fakeCli: { claude: INERT_CLI },
  });
  // Каталог данных панели стенда — его же ядро стенда читает как AGENTDECK_PANEL_DATA.
  panelData = join(stand.cfg, 'agentdeck');
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-recorded-walk-proj-')));
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, '.git', 'info', 'exclude'), '.agent/\n');
  writeFileSync(join(project, 'README.md'), 'stand\n');
  git(project, 'add', '.');
  git(project, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
  const added = await stand.api('/projects', {
    method: 'POST',
    body: { path: project, name: 'recorded-walk' },
  });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  bound = saveEnvironment(project, { title: 'QA', baseUrl: STAND_ORIGIN, isDefault: true }).id;
  declareSecret(project, bound, { name: 'STAND_PASSWORD', title: 'Пароль стенда' });
  declareSecret(project, bound, { name: 'STAND_UNSET', title: 'Без значения' });
  writeSecretValue(panelData, project, bound, 'STAND_PASSWORD', MARKER);
  other = saveEnvironment(project, { title: 'Другой', baseUrl: OTHER_ORIGIN }).id;
  declareSecret(project, other, { name: 'OTHER_TOKEN', title: 'Чужой токен' });
  writeSecretValue(panelData, project, other, 'OTHER_TOKEN', OTHER_MARKER);
  walk = await stand.api('/project-tests/recorded/walk', {
    method: 'POST',
    body: { path: project, goal: 'войти на стенд', environmentId: bound },
  });
}, 240_000);

afterAll(async () => {
  await stand?.stop();
  if (project) rmSync(project, { recursive: true, force: true, maxRetries: 10 });
}, 60_000);

/** Строки журнала задачи в доме ядра стенда. */
function journalOf(taskId: string): Array<{ kind: string; data: Record<string, unknown> }> {
  const file = filesUnder(stand.coreHome).find(
    (path) => path.includes(taskId) && path.endsWith('journal.jsonl'),
  );
  expect(file, `журнал задачи ${taskId} в ${stand.coreHome}`).toBeTruthy();
  return readFileSync(file!, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
}

describe('recorded walk: panel route to a live core, stand secrets by name', () => {
  it('the route opens a core task whose request names exactly the environment secrets', () => {
    const trail = filesUnder(stand.coreHome)
      .filter((path) => path.endsWith('journal.jsonl'))
      .map((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const row = JSON.parse(line) as { kind: string; data?: Record<string, unknown> };
            return `${row.kind} ${JSON.stringify(row.data ?? {}).slice(0, 160)}`;
          })
          .join('\n'),
      )
      .join('\n---\n');
    expect(walk.status, `${JSON.stringify(walk.body)}\n${trail}`).toBe(200);
    const taskId = (walk.body as { taskId: string }).taskId;
    // Запуск — политикой ядра после оценки: команды `launch` в состоянии `estimating` нет (она
    // была `state-conflict` на каждом проходе до W3-D F2).
    const lines = journalOf(taskId);
    expect(lines.find((line) => line.kind === 'task.created')?.data.launchPolicy).toBe('auto');
    expect(lines.filter((line) => line.kind === 'command.rejected')).toEqual([]);
    const request = filesUnder(stand.coreHome).find(
      (path) => path.includes(taskId) && path.endsWith('request.md'),
    );
    const text = readFileSync(request!, 'utf8');
    expect(text).toContain('Fill credentials only by secret name: STAND_PASSWORD, STAND_UNSET.');
    expect(text).not.toContain('OTHER_TOKEN');
    expect(text).toContain(STAND_ORIGIN);
  });

  it('the core resolves those names from its own task roots: the value only at its stand, others refused by code', () => {
    const taskId = (walk.body as { taskId: string }).taskId;
    const created = journalOf(taskId).find((line) => line.kind === 'task.created')!.data;
    const { roots, reads } = coreReads(panelData, created, [
      ['STAND_PASSWORD', `${STAND_ORIGIN}/login`],
      ['OTHER_TOKEN', `${STAND_ORIGIN}/login`],
      ['STAND_PASSWORD', `${OTHER_ORIGIN}/login`],
      ['STAND_UNSET', `${STAND_ORIGIN}/login`],
      ['NOT_DECLARED', `${STAND_ORIGIN}/login`],
    ]);
    expect(reads).toEqual([
      {
        name: 'STAND_PASSWORD',
        url: `${STAND_ORIGIN}/login`,
        environmentId: bound,
        matches: 'MARKER',
      },
      { name: 'OTHER_TOKEN', url: `${STAND_ORIGIN}/login`, refused: 'secret-not-for-this-page' },
      { name: 'STAND_PASSWORD', url: `${OTHER_ORIGIN}/login`, refused: 'secret-not-for-this-page' },
      { name: 'STAND_UNSET', url: `${STAND_ORIGIN}/login`, refused: 'secret-missing' },
      { name: 'NOT_DECLARED', url: `${STAND_ORIGIN}/login`, refused: 'secret-not-for-this-page' },
    ]);
    expect(roots.length).toBeGreaterThan(0);
    // Контроль: чужое окружение на своём адресе своё имя получает — отказ выше не «всегда отказ».
    expect(coreReads(panelData, created, [['OTHER_TOKEN', `${OTHER_ORIGIN}/x`]]).reads).toEqual([
      {
        name: 'OTHER_TOKEN',
        url: `${OTHER_ORIGIN}/x`,
        environmentId: other,
        matches: 'OTHER_MARKER',
      },
    ]);
  });

  it('no value lands in the core home, the project files or the logs of the panel and the core', () => {
    const where: string[] = [];
    for (const file of [...filesUnder(stand.coreHome), ...filesUnder(join(project, '.agent'))]) {
      const text = readFileSync(file, 'latin1');
      if (text.includes(MARKER) || text.includes(OTHER_MARKER)) where.push(file);
    }
    for (const [name, text] of [
      ['panel log', stand.log()],
      ['core log', stand.coreLog()],
      ['walk reply', JSON.stringify(walk.body)],
    ] as const) {
      if (text.includes(MARKER) || text.includes(OTHER_MARKER)) where.push(name);
    }
    expect(filesUnder(stand.coreHome).length).toBeGreaterThan(0);
    expect(where).toEqual([]);
  });
});

describe('recorded walk from a repo subfolder: the core task roots reach the project', () => {
  /**
   * Проект в подпапке репозитория (`repo/app`): панель шлёт корень проекта, ядро закрепляет
   * репозиторий по `git --show-toplevel` (`task.created.repos[].path` = `repo`), а доступы стенда
   * лежат в `repo/app/.agent/tests`. Корни задачи обязаны вести к проекту, иначе проход не находит
   * ни одного доступа своего окружения: оценка несёт подпапку (`repos[].subPath = 'app'`), корни
   * считает код ядра (`projectRootsOf`).
   */
  it('a project in a repo subfolder: the core task roots still reach that project, its secret resolves at its stand', async () => {
    const outer = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-recorded-walk-outer-')));
    try {
      const sub = join(outer, 'app');
      git(outer, 'init', '-q', '-b', 'main');
      writeFileSync(join(outer, '.git', 'info', 'exclude'), '.agent/\n');
      mkdirSync(sub);
      writeFileSync(join(sub, 'README.md'), 'sub\n');
      git(outer, 'add', '.');
      git(outer, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
      const added = await stand.api('/projects', {
        method: 'POST',
        body: { path: sub, name: 'recorded-walk-sub' },
      });
      expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
      const env = saveEnvironment(sub, { title: 'QA', baseUrl: STAND_ORIGIN, isDefault: true }).id;
      declareSecret(sub, env, { name: 'STAND_PASSWORD', title: 'Пароль стенда' });
      writeSecretValue(panelData, sub, env, 'STAND_PASSWORD', MARKER);
      const subWalk = await stand.api('/project-tests/recorded/walk', {
        method: 'POST',
        body: { path: sub, goal: 'войти на стенд', environmentId: env },
      });
      expect(subWalk.status, JSON.stringify(subWalk.body)).toBe(200);
      const created = journalOf((subWalk.body as { taskId: string }).taskId).find(
        (line) => line.kind === 'task.created',
      )!.data;
      const { roots, reads } = coreReads(panelData, created, [
        ['STAND_PASSWORD', `${STAND_ORIGIN}/login`],
      ]);
      expect(reads, `корни задачи: ${JSON.stringify(roots)}`).toEqual([
        {
          name: 'STAND_PASSWORD',
          url: `${STAND_ORIGIN}/login`,
          environmentId: env,
          matches: 'MARKER',
        },
      ]);
    } finally {
      rmSync(outer, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 120_000);
});
