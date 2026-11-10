import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeSecretValue } from '../env-secrets/env-secrets.ts';
import { declareSecret, saveEnvironment } from '../library/library.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { recordedCases } from './history.ts';
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
 * Настоящий путь R3–R4 (P179–P180): записанный проход → спек на диске → «Прогнать все» через
 * настоящие `tests-cli run --env --max-failures 1` и `junit-run.mjs` → настоящий Chromium по
 * стенду-фикстуре. Подменены только внешние границы: стенд (HTTP этого процесса), ядро (порт
 * прохода считает вызовы), модель (заглушка со следом — её адрес у процесса прогона).
 *
 * Зелёный повтор не зовёт ни ядро, ни модель; поменялся стенд — прогон встаёт на первом упавшем
 * шаге первого сценария, второй не запускается, задача прохода ровно одна и называет этот шаг.
 */

const REPO = resolve(__dirname, '../../../../../..');
const PASSWORD = 'stand-secret-42';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Стенд: вход с паролем, на главной — приветствие; `greeting` меняет фикстуру, `hits` считает
 * запросы страниц — зелёный без них значил бы, что повтор по стенду не шёл (журнал проверок
 * 09.11 «прогнал» этот файл за 3 с, не открыв ни страницы: потому файл `*.live.*`, и
 * `junit-run` гонит его мимо журнала).
 */
function stand(greeting: { text: string }, hits: string[]): Promise<Server> {
  const login = `<!doctype html><html><body><form id="f">
<label>Почта <input name="email"></label>
<label>Пароль <input name="password" type="password"></label>
<button type="button" id="go">Войти</button></form>
<script>document.getElementById('go').onclick = () => {
  if (document.querySelector('[name=password]').value === ${JSON.stringify(PASSWORD)}) location.href = '/home';
};</script></body></html>`;
  const server = createServer((request, reply) => {
    reply.setHeader('content-type', 'text/html; charset=utf-8');
    hits.push(request.url ?? '');
    if (request.url === '/login') return reply.end(login);
    if (request.url === '/home') {
      return reply.end(
        `<!doctype html><html><body><button>Меню</button><p data-testid="greeting">${greeting.text}</p></body></html>`,
      );
    }
    reply.statusCode = request.url === '/' ? 200 : 404;
    return reply.end('<!doctype html><html><body>stand</body></html>');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

describe('recorded replay on the real path', { timeout: 240_000 }, () => {
  let dir = '';
  let appData = '';
  let traceFile = '';
  let site: Server;
  let stub: StubModel;
  const greeting = { text: 'Привет, demo' };
  const hits: string[] = [];
  const pages = () => hits.filter((url) => url === '/login' || url === '/home');
  const opened: RecordedWalkRequest[] = [];
  let replays: RecordedReplays;
  let ids: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-recorded-int-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-recorded-appdata-'));
    traceFile = join(appData, 'stub-trace.jsonl');
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nnode_modules\ntest-results/\n');
    writeFileSync(join(dir, 'README.md'), 'stand\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    // Спек ищет пакет playwright вверх от себя — как в проекте, где он стоит.
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction');
    site = await stand(greeting, hits);
    stub = await startStubModel({ trace: traceFile });
    const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const environment = saveEnvironment(dir, { title: 'QA', baseUrl: origin, isDefault: true });
    declareSecret(dir, environment.id, { name: WALK_SECRET, title: 'Пароль стенда' });
    writeSecretValue(appData, dir, environment.id, WALK_SECRET, PASSWORD);
    // Запись — на другом адресе: повтор обязан идти по адресу окружения (`E2E_BASE_URL`).
    const recordedOn = 'http://127.0.0.1:1';
    ids = ['Вход на стенд', 'Вход ещё раз'].map(
      (title, index) =>
        recordWalk(
          dir,
          { path: dir, groupId: 'scenarios', title, taskId: `t${index}`, ...walkRows(recordedOn) },
          '2026-11-09T10:00:00.000Z',
        ).caseId,
    );
    replays = new RecordedReplays({
      walk: {
        open: async (request) => {
          opened.push(request);
          return { taskId: `walk-${opened.length}` };
        },
      },
      appData,
      // Модель процесса прогона — заглушка: любой вызов модели лёг бы в её след.
      runCli: (args, env) =>
        spawnTestsCli(args, {
          ...env,
          ANTHROPIC_BASE_URL: stub.baseUrl,
          OPENAI_BASE_URL: `${stub.baseUrl}/v1`,
          AGENTDECK_BRIEF_OUTPUT: '',
        }),
    });
  });

  afterAll(async () => {
    await stub?.close();
    await new Promise((done) => site?.close(done));
    rmSync(join(dir, 'node_modules'), { force: true, recursive: false });
    for (const path of [dir, appData]) {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('green replay: both scenarios pass, no walk task, the stub model is never called', async () => {
    const spec = readFileSync(
      join(dir, `.agent/tests/recorded/scenarios/${ids[0]}.recorded.mjs`),
      'utf8',
    );
    expect(spec).not.toContain(PASSWORD);
    replays.start(dir);
    const state = await replays.settled(dir)!;
    expect(state.error ?? '').toBe('');
    expect(state.status).toBe('passed');
    expect(opened).toHaveLength(0);
    // Оба сценария прошли по стенду на самом деле: вход и главная — по разу на каждый.
    expect(pages()).toEqual(['/login', '/home', '/login', '/home']);
    expect(existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim() : '').toBe('');
    const run = readRuns(dir, 1)[0]!;
    expect(run.id).toBe(state.runId);
    expect(run.environmentId).toBe(state.environmentId);
    expect(run.results.map((result) => [result.caseId, result.status])).toEqual([
      [ids[0], 'passed'],
      [ids[1], 'passed'],
    ]);
  });

  it('changed stand: stops at the first failing step and opens exactly one walk task naming it', async () => {
    greeting.text = 'Здравствуйте, demo';
    const before = pages().length;
    replays.start(dir);
    const state = await replays.settled(dir)!;
    expect(state.status).toBe('mismatch');
    // Первый сценарий дошёл до главной и встал; второй стенда не открывал.
    expect(pages().slice(before)).toEqual(['/login', '/home']);
    expect(opened).toHaveLength(1);
    expect(state.mismatch).toMatchObject({
      caseId: ids[0],
      step: { n: 5, title: 'в элемент data-testid «greeting» текст «Привет, demo»' },
      taskId: 'walk-1',
    });
    expect(opened[0]!.text).toContain('at step 5');
    const run = readRuns(dir, 1)[0]!;
    const second = run.results.find((result) => result.caseId === ids[1])!;
    expect(second.status).toBe('skipped');
    expect(second.note).toContain('Не запускался');
    expect(existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim() : '').toBe('');
    const history = recordedCases(dir).find((item) => item.caseId === ids[0])!.history;
    expect(history.map((mark) => mark.status)).toEqual(['failed', 'passed']);
  });
});
