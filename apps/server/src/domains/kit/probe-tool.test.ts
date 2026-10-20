import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Постоянный браузер для живых проб (`tools/probe.mjs`): браузер переживает
 * пробу, каждая проба — в свежем контексте, общее только явно названное
 * storageState. Настоящий Playwright проекта и настоящий локальный сервер:
 * изоляцию и тёплый запуск нельзя доказать без браузера. Запуск асинхронный —
 * синхронный держал бы цикл событий, и сервер в этом же процессе молчал бы.
 */

const TOOL = join(builtinKitDir(), 'tools', 'probe.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-probe-'));
const env = { ...process.env, PROBE_DIR: join(dir, 'state') };
let server: Server;
let origin = '';

function probe(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, `export default async ({ page, context, args }) => {\n${body}\n};\n`);
  return file;
}

type Ran = { code: number; out: string; err: string };

function runWith(extra: NodeJS.ProcessEnv, args: string[]): Promise<Ran> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [TOOL, ...args],
      { cwd: process.cwd(), env: { ...env, ...extra }, encoding: 'utf8', timeout: 90_000 },
      (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }),
    );
  });
}

const run = (...args: string[]): Promise<Ran> => runWith({}, args);

/** Браузер Playwright проекта запускается — иначе (свежий Linux, CI без `playwright install`) пробе нечего доказывать. */
async function browserStarts(): Promise<boolean> {
  try {
    const { chromium } = createRequire(join(process.cwd(), 'x.js'))('playwright') as {
      chromium: { launch: () => Promise<{ close: () => Promise<void> }> };
    };
    await (await chromium.launch()).close();
    return true;
  } catch {
    return false;
  }
}
const hasBrowser = await browserStarts();

beforeAll(async () => {
  server = createServer((_, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<title>stand</title><h1>Стенд</h1>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await run('stop');
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// Linux 20.10: без скачанного браузера проба ждала 30 с и говорила только «did not start».
describe('kit probe — браузер не скачан', () => {
  it('причина приходит сразу, а не через 30 с ожидания', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'kit-probe-nobrowser-'));
    try {
      const file = probe('none', `return 1;`);
      const started = Date.now();
      const ran = await runWith({ PLAYWRIGHT_BROWSERS_PATH: empty, PROBE_DIR: join(empty, 'st') }, [
        'run',
        file,
      ]);
      expect(ran.code).toBe(1);
      expect(ran.err).toMatch(/the browser did not start: .*Executable doesn't exist/);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!hasBrowser)('kit probe — постоянный браузер', { timeout: 120_000 }, () => {
  it('первая проба поднимает браузер, следующие — тёплые; печатается только возврат пробы', async () => {
    const read = probe(
      'read',
      `await page.goto(args[0]);\nconsole.error('noise');\nreturn { h1: await page.textContent('h1') };`,
    );
    const cold = await run('run', read, '--', origin);
    expect(cold.code, cold.err).toBe(0);
    expect(JSON.parse(cold.out)).toEqual({ h1: 'Стенд' });
    expect(cold.err).toMatch(/browser cold/);
    const warm = await run('run', read, '--', origin);
    expect(warm.err).toMatch(/browser warm/);
    expect((await run('status')).out).toMatch(/^running: pid \d+/);
  });

  it('проба не видит состояние прошлой; storageState переносится только по флагам', async () => {
    const write = probe(
      'write',
      `await page.goto(args[0]);\nawait page.evaluate(() => localStorage.setItem('k', 'v'));\nawait context.addCookies([{ name: 'c', value: '1', url: args[0] }]);\nreturn 'ok';`,
    );
    const look = probe(
      'look',
      `await page.goto(args[0]);\nreturn { ls: await page.evaluate(() => localStorage.getItem('k')), cookies: (await context.cookies()).length };`,
    );
    const auth = join(dir, 'auth.json');
    const saved = await run('run', write, '--save-state', auth, '--', origin);
    expect(saved.code, saved.err).toBe(0);
    expect(JSON.parse(readFileSync(auth, 'utf8')).cookies).toHaveLength(1);
    expect(JSON.parse((await run('run', look, '--', origin)).out)).toEqual({
      ls: null,
      cookies: 0,
    });
    expect(JSON.parse((await run('run', look, '--state', auth, '--', origin)).out)).toEqual({
      ls: 'v',
      cookies: 1,
    });
  });

  it('зависшая проба падает по таймауту, большой ответ обрезается, браузер жив', async () => {
    const hang = probe('hang', `await new Promise(() => {});`);
    const hung = await run('run', hang, '--timeout', '1');
    expect(hung.code).toBe(1);
    expect(hung.err).toMatch(/timed out after 1 s/);
    const big = probe('big', `return 'x'.repeat(500);`);
    expect((await run('run', big, '--max', '50')).out).toMatch(/cut: 502 chars/);
    expect((await run('status')).out).toMatch(/^running/);
  });

  it('stop гасит сервер браузера и убирает его след', async () => {
    const pid = Number(/pid (\d+)/.exec((await run('status')).out)?.[1]);
    expect((await run('stop')).out).toMatch(/stopped browser server/);
    expect((await run('status')).out).toMatch(/no browser server running/);
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
    expect(existsSync(join(dir, 'state'))).toBe(true);
  });
});
