import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs --health` над скриптом-проверкой и заглушкой адреса стенда.
 * 09.11 настоящий провал testing-009 записался «стенд пропадал» (skipped): панель считала lint по
 * 4487 кейсам и не ответила на ОДИН опрос за 3 с, хотя была жива. Стенд виноват, только когда два
 * опроса подряд без ответа И повторная проверка с долгим ожиданием тоже не дозвалась.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');

type Health = (count: number, root: string) => { status: number; delayMs?: number };

const roots: string[] = [];
let server: Server | undefined;
let running: ChildProcess | undefined;

afterEach(async () => {
  running?.kill();
  running = undefined;
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  // Скрипт-внук упавшего по таймауту прогона ещё может держать каталог (Windows EBUSY) — до 20 с.
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 1000 });
  }
});

/** Заглушка адреса стенда: ответ на n-й запрос решает `health` (код и задержка ответа). */
async function healthStub(root: string, health: Health): Promise<string> {
  let count = 0;
  server = createServer((_req, res) => {
    count += 1;
    const { status, delayMs = 0 } = health(count, root);
    setTimeout(() => res.writeHead(status).end(), delayMs);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

/** Временный проект: скрипт `check.mjs` (код из `script`) привязан к кейсу g-1. */
function project(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'junit-run-health-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(root, 'check.mjs'), script);
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [
        {
          id: 'g-1',
          type: 'case',
          title: 'g-1',
          automation: { status: 'automated', file: 'check.mjs' },
        },
      ],
    }),
  );
  return root;
}

/** junit-run асинхронно: заглушка стенда живёт в этом же процессе и должна отвечать. */
function junitRun(root: string, url: string): Promise<{ stdout: string; report: string }> {
  const out = join(root, 'out', 'junit.xml');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  delete env.AGENTDECK_TEST_CASES;
  delete env.JUNIT_RUN_HEALTH;
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [JUNIT_RUN, '--project', root, '--out', out, '--health', url, 'check.mjs'],
      { cwd: root, env, windowsHide: true },
    );
    running = child;
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('error', fail);
    child.on('close', () =>
      done({ stdout, report: existsSync(out) ? readFileSync(out, 'utf8') : '' }),
    );
  });
}

const testcase = (report: string) =>
  report.match(
    /<testcase [^>]*name="\[g-1\][^>]*>[\s\S]*?<\/testcase>|<testcase [^>]*name="\[g-1\][^>]*\/>/,
  )?.[0] ?? '';

describe('junit-run --health: стенд виноват только после двух пропусков подряд и неудачной перепроверки', () => {
  it('одиночные пропуски опроса во время настоящего провала — провал кейса, не «стенд пропадал»', async () => {
    const root = project(`setTimeout(() => process.exit(1), 7000);\n`);
    // Каждый второй запрос — 503: пропуски есть в каждой попытке, но ни разу два подряд.
    const url = await healthStub(root, (n) => ({ status: n % 2 === 0 ? 503 : 200 }));
    const { stdout, report } = await junitRun(root, url);
    expect(testcase(report)).toMatch(/<failure/);
    expect(testcase(report)).not.toMatch(/<skipped/);
    expect(stdout).not.toMatch(/стенд пропадал/);
  }, 90_000);

  it('пропуск, за которым сразу провал перепроверки, — ещё не «стенд пропадал»: нужен второй пропуск подряд', async () => {
    const root = project(`setTimeout(() => process.exit(1), 9000);\n`);
    // Ответ, два 503, ответ, два 503…: перепроверка после одного пропуска попала бы на второй 503,
    // а после двух подряд — всегда на ответ.
    const url = await healthStub(root, (n) => ({ status: n % 3 === 1 ? 200 : 503 }));
    const { stdout, report } = await junitRun(root, url);
    expect(testcase(report)).toMatch(/<failure/);
    expect(stdout).not.toMatch(/стенд пропадал/);
  }, 90_000);

  it('стенд жив, но занят (ответ позже опроса): два пропуска подряд, перепроверка дозвалась — провал кейса', async () => {
    // Скрипт снимает метку на старте и ставит на выходе: пока он идёт, стенд «занят».
    const root = project(
      `import { unlinkSync, writeFileSync } from 'node:fs';\n` +
        `try { unlinkSync('done.flag'); } catch {}\n` +
        `setTimeout(() => { writeFileSync('done.flag', ''); process.exit(1); }, 15000);\n`,
    );
    // Ответ через 4 с, пока проверка идёт: опрос (3 с) его не дождётся, перепроверка с долгим
    // ожиданием — дождётся. Ожидание стенда до старта (первый запрос) и после — сразу.
    const url = await healthStub(root, (n, dir) => ({
      status: 200,
      delayMs: n === 1 || existsSync(join(dir, 'done.flag')) ? 0 : 4000,
    }));
    const { stdout, report } = await junitRun(root, url);
    expect(testcase(report)).toMatch(/<failure/);
    expect(testcase(report)).not.toMatch(/<skipped/);
    expect(stdout).not.toMatch(/стенд пропадал/);
  }, 90_000);

  it('стенд правда лёг во время проверки — повтор на поднявшемся стенде, засчитан повтор', async () => {
    // Первая попытка: 7 с без стенда, затем метка и код 1. Повтор (метка есть) — код 0.
    const root = project(
      `import { existsSync, writeFileSync } from 'node:fs';\n` +
        `if (existsSync('up.flag')) process.exit(0);\n` +
        `setTimeout(() => { writeFileSync('up.flag', ''); process.exit(1); }, 7000);\n`,
    );
    // До метки стенд отвечает только на первый запрос (ожидание до старта), дальше — 503.
    const url = await healthStub(root, (n, dir) => ({
      status: n === 1 || existsSync(join(dir, 'up.flag')) ? 200 : 503,
    }));
    const { stdout, report } = await junitRun(root, url);
    expect(stdout).toMatch(/стенд пропадал во время проверки/);
    expect(testcase(report)).not.toMatch(/<failure|<skipped/);
  }, 90_000);
});
