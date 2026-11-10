import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeSecretValue } from '../env-secrets/env-secrets.ts';
import { declareSecret, saveEnvironment } from '../library/library.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { recordWalk } from './record.ts';
import { RecordedReplays, spawnTestsCli } from './replay.ts';
import type { RecordedWalkRequest } from './recorded.types.ts';
import { WALK_SECRET, walkRows } from './__fixtures__/walk-rows.ts';
// Пакет заглушки модели — без сборки, у сервера в зависимостях его нет: путём от корня.
import {
  startStubModel,
  type StubModel,
} from '../../../../../../packages/stub-model/src/index.mjs';

/**
 * Доступ стенда в повторе записанного прохода — настоящий путь (Z11 → W3-D F2): хранилище
 * доступов панели → `tests-cli run --env` → `junit-run.mjs` → процесс спека → поле страницы.
 * Подменены только внешние границы: стенд (HTTP этого процесса), чужой сайт (второй HTTP),
 * ядро (порт прохода считает вызовы), модель (заглушка).
 *
 * Значение — уникальная метка: она обязана дойти до поля своего стенда (вход проходит) и не
 * появиться больше НИГДЕ — ни в спеке, ни в кейсе, ни в истории прогонов, ни в выводе CLI, ни в
 * состоянии повтора, ни в задании прохода, ни в логе процесса. Стенд увёл на чужой адрес —
 * шаг доступа встаёт с ИМЕНЕМ доступа, а чужой сайт значения не получает (доступ привязан к
 * адресу окружения). Значения нет или окружение доступа не объявляет — «не проверено» с
 * именем, а не буквальный `undefined` в поле.
 */

const REPO = resolve(__dirname, '../../../../../..');
const MARKER = `mk${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Форма входа: всё, что набрано в поля, страница шлёт своему серверу (`/typed`). */
function loginPage(password: string): string {
  return `<!doctype html><html><body><form id="f">
<label>Почта <input name="email" oninput="navigator.sendBeacon('/typed', this.value)"></label>
<label>Пароль <input name="password" type="password" oninput="navigator.sendBeacon('/typed', this.value)"></label>
<button type="button" id="go">Войти</button></form>
<script>document.getElementById('go').onclick = () => {
  if (document.querySelector('[name=password]').value === ${JSON.stringify(password)}) location.href = '/home';
};</script></body></html>`;
}

interface Site {
  server: Server;
  origin: string;
  /** Адреса запрошенных страниц. */
  hits: string[];
  /** Всё, что набрано в поля страниц этого сайта. */
  typed: string[];
}

/** Сайт: `/login`, `/home`, приём набранного; `redirect` уводит вход на чужой адрес. */
function site(password: string, redirect: { to?: string }): Promise<Site> {
  const hits: string[] = [];
  const typed: string[] = [];
  const server = createServer((request, reply) => {
    if (request.url === '/typed') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        typed.push(body);
        reply.end();
      });
      return;
    }
    // `/` — опрос здоровья стенда (`--health` запускателя), не страница прохода.
    if (request.url !== '/') hits.push(request.url ?? '');
    if (request.url === '/login' && redirect.to) {
      reply.statusCode = 302;
      reply.setHeader('location', `${redirect.to}/login`);
      return reply.end();
    }
    reply.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/login') return reply.end(loginPage(password));
    if (request.url === '/home') {
      return reply.end(
        '<!doctype html><html><body><button>Меню</button><p data-testid="greeting">Привет, demo</p></body></html>',
      );
    }
    reply.statusCode = request.url === '/' ? 200 : 404;
    return reply.end('<!doctype html><html><body>site</body></html>');
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        typed,
      }),
    ),
  );
}

/** Все файлы под каталогом, кроме node_modules и .git. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe('recorded replay stand secrets on the real path', { timeout: 240_000 }, () => {
  let dir = '';
  let appData = '';
  let stand: Site;
  let foreign: Site;
  let stub: StubModel;
  const redirect: { to?: string } = {};
  const opened: RecordedWalkRequest[] = [];
  const cliOutput: string[] = [];
  const logged: string[] = [];
  const states: unknown[] = [];
  let replays: RecordedReplays;
  let caseId = '';
  let bound = '';
  let valueless = '';
  let unwired = '';

  beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        logged.push(parts.map(String).join(' '));
      });
    }
    dir = mkdtempSync(join(tmpdir(), 'cc-recorded-secret-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-recorded-secret-appdata-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nnode_modules\ntest-results/\n');
    writeFileSync(join(dir, 'README.md'), 'stand\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction');
    stand = await site(MARKER, redirect);
    foreign = await site(MARKER, {});
    stub = await startStubModel({ trace: join(appData, 'stub-trace.jsonl') });
    bound = saveEnvironment(dir, { title: 'QA', baseUrl: stand.origin, isDefault: true }).id;
    declareSecret(dir, bound, { name: WALK_SECRET, title: 'Пароль стенда' });
    writeSecretValue(appData, dir, bound, WALK_SECRET, MARKER);
    valueless = saveEnvironment(dir, { title: 'Без значения', baseUrl: stand.origin }).id;
    declareSecret(dir, valueless, { name: WALK_SECRET, title: 'Пароль стенда' });
    unwired = saveEnvironment(dir, { title: 'Без доступа', baseUrl: stand.origin }).id;
    caseId = recordWalk(
      dir,
      {
        path: dir,
        groupId: 'scenarios',
        title: 'Вход на стенд',
        taskId: 't0',
        ...walkRows('http://127.0.0.1:1'),
      },
      '2026-11-09T10:00:00.000Z',
    ).caseId;
    replays = new RecordedReplays({
      walk: {
        open: async (request) => {
          opened.push(request);
          return { taskId: `walk-${opened.length}` };
        },
      },
      appData,
      runCli: async (args, env) => {
        const outcome = await spawnTestsCli(args, {
          ...env,
          ANTHROPIC_BASE_URL: stub.baseUrl,
          OPENAI_BASE_URL: `${stub.baseUrl}/v1`,
          AGENTDECK_BRIEF_OUTPUT: '',
          RECORDED_STEP_TIMEOUT_MS: '3000',
        });
        cliOutput.push(outcome.output);
        return outcome;
      },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await stub?.close();
    for (const one of [stand, foreign]) await new Promise((done) => one?.server.close(done));
    rmSync(join(dir, 'node_modules'), { force: true, recursive: false });
    for (const path of [dir, appData]) {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  async function replay(environmentId: string) {
    replays.start(dir, { environmentId });
    const state = await replays.settled(dir)!;
    states.push(state);
    return state;
  }

  it('bound origin: the value reaches the stand field from the store, the login passes', async () => {
    const state = await replay(bound);
    expect(state.error ?? '').toBe('');
    expect(state.status).toBe('passed');
    // Пароль совпал на странице своего стенда — значит, значение дошло из хранилища до поля.
    expect(stand.hits).toEqual(['/login', '/home']);
    expect(stand.typed).toContain(MARKER);
    expect(opened).toHaveLength(0);
  });

  it('a redirect to a foreign origin stops the secret step by NAME, the foreign site never gets the value', async () => {
    redirect.to = foreign.origin;
    const hitsBefore = stand.hits.length;
    const state = await replay(bound);
    redirect.to = undefined;
    expect(stand.hits.slice(hitsBefore)).toEqual(['/login']);
    expect(foreign.hits).toEqual(['/login']);
    // Почта (не доступ) на чужой странице набрана — шаг доступа встал до набора.
    expect(foreign.typed).toEqual(['demo@example.com']);
    expect(foreign.typed.join('\n')).not.toContain(MARKER);
    expect(state.status).toBe('mismatch');
    // Шаги спека нумеруются заново: снимок страницы в спек не идёт, ввод доступа — шаг 3.
    expect(state.mismatch?.step).toEqual({
      n: 3,
      title: `ввести доступ ${WALK_SECRET} в поле «Пароль»`,
    });
    expect(state.mismatch?.message).toContain(WALK_SECRET);
    expect(state.mismatch?.message).toContain('не для этой страницы');
    expect(state.mismatch?.message).toContain(foreign.origin);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.text).toContain('at step 3');
  });

  it('no value or an environment without the secret: «не проверено» naming it, the page never opens', async () => {
    for (const environmentId of [valueless, unwired]) {
      const hitsBefore = stand.hits.length;
      const state = await replay(environmentId);
      expect(state.status, environmentId).toBe('failed');
      expect(state.error, environmentId).toContain(WALK_SECRET);
      expect(state.error, environmentId).toContain('нет доступов стенда');
      expect(state.error ?? '', environmentId).not.toContain('undefined');
      expect(stand.hits.slice(hitsBefore), environmentId).toEqual([]);
      const run = readRuns(dir, 1)[0]!;
      expect(run.environmentId).toBe(environmentId);
      const result = run.results.find((item) => item.caseId === caseId)!;
      expect(result.status).toBe('skipped');
      expect(result.note).toContain(WALK_SECRET);
    }
    expect(stand.typed).not.toContain('undefined');
    expect(foreign.typed).not.toContain('undefined');
  });

  it('the value appears nowhere: spec, case, run history, CLI output, replay state, walk task, process log, panel data', () => {
    const where: string[] = [];
    for (const file of [...filesUnder(dir), ...filesUnder(appData)]) {
      if (readFileSync(file, 'latin1').includes(MARKER)) where.push(file);
    }
    const texts: Record<string, string> = {
      cli: cliOutput.join('\n'),
      states: JSON.stringify(states),
      walk: JSON.stringify(opened),
      log: logged.join('\n'),
    };
    for (const [name, text] of Object.entries(texts)) if (text.includes(MARKER)) where.push(name);
    // Проверка способна покраснеть: прогоны были, вывод CLI не пуст, спек и история на месте.
    expect(cliOutput.length).toBe(4);
    expect(filesUnder(dir).some((file) => file.endsWith('.recorded.mjs'))).toBe(true);
    expect(readRuns(dir, 10)).toHaveLength(4);
    expect(where).toEqual([]);
  });
});
