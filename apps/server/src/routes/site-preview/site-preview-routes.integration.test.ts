import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  PICK_MESSAGE_TYPE,
  PICK_SCRIPT_PATH,
  type PickPayload,
  type SitePreview,
} from '@agentdeck/contracts/site-preview';
import type { ServerContext } from '../../context.ts';
import { ProjectRunnerRegistry } from '../../domains/project-runner/project-runner.ts';
import { PICK_TAG } from '../../domains/site-preview/site-preview.ts';
import { registerSitePreviewRoutes } from './site-preview-routes.ts';

/**
 * Окно сайта на настоящей дороге (P173): настоящий реестр запусков поднимает настоящий процесс
 * поддельного dev-сервера (`__fixtures__/dev-site.mjs`), маршрут открывает прокси, запросы идут
 * сетью. Подменён только сам сайт — прокси, вставка, WebSocket и закрытие те же, что у человека.
 */

const FIXTURE = join(import.meta.dirname, '../../domains/site-preview/__fixtures__/dev-site.mjs');
const SECRET = ['sk', 'plantedStandSecret0042'].join('-');

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Сырой запрос: свой `Host`, свой путь (в том числе абсолютный адрес) — как пришлёт кто угодно. */
function raw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  host = '127.0.0.1',
): Promise<Raw> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host, port, path, headers, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', fail);
    req.end();
  });
}

/** Принимает ли порт соединения на адресе `host` (закрытый прокси — отказ соединения). */
function accepts(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host });
    socket.setTimeout(1500, () => {
      socket.destroy();
      done(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

/** Один круг WebSocket через прокси: отправили слово — получили его же. */
function wsRoundTrip(url: string, word: string, origin?: string): Promise<string> {
  return new Promise((done, fail) => {
    // undici WebSocket Node 22: заголовки — нестандартной опцией, как делает HMR-клиент Vite.
    const ws = new WebSocket(url, origin ? ({ headers: { origin } } as never) : undefined);
    const timer = setTimeout(() => fail(new Error('ws timeout')), 5000);
    ws.onopen = () => ws.send(word);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      done(String(event.data));
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      fail(new Error('ws error'));
    };
  });
}

async function until(probe: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((sleep) => setTimeout(sleep, 100));
  }
  return false;
}

/** Внешний (не loopback) IPv4 машины, если он есть: на нём прокси слушать не должен. */
function externalIp(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return undefined;
}

describe('окно сайта: прокси над запуском панели (P173)', { timeout: 60_000 }, () => {
  let root: string;
  let registry: ProjectRunnerRegistry;
  let app: FastifyInstance;

  const startSite = async (name: string): Promise<{ dir: string; port: number }> => {
    const dir = join(root, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE, join(dir, 'dev-site.mjs'));
    await registry.start({ projectPath: dir });
    const ready = await until(() => registry.get({ projectPath: dir })?.status === 'running');
    const view = registry.get({ projectPath: dir });
    if (!ready || !view?.url || view.port === undefined) {
      throw new Error(`fixture site did not start: ${JSON.stringify(view)}`);
    }
    return { dir, port: view.port };
  };

  const open = async (path: string) =>
    app.inject({ method: 'POST', url: '/api/site-preview', payload: { path } });

  beforeAll(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-site-preview-')));
    registry = new ProjectRunnerRegistry({
      openBrowser: () => {},
      resolveLaunch: (targetDir) => ({
        file: process.execPath,
        args: [join(targetDir, 'dev-site.mjs')],
        display: 'node dev-site.mjs',
      }),
    });
    app = Fastify();
    registerSitePreviewRoutes(app, {} as ServerContext, registry);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    registry.stopAll();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // temp уйдёт с ОС
    }
  });

  it('открывает прокси на 127.0.0.1: вставлен ровно один скрипт, JS байт в байт, WebSocket проходит, чужой хост — 403', async () => {
    const site = await startSite('site-a');
    const reply = await open(site.dir);
    expect(reply.statusCode).toBe(200);
    const preview = reply.json<SitePreview>();
    expect(preview.nonce.length).toBeGreaterThanOrEqual(16);
    const url = new URL(preview.url);
    expect(url.hostname).toBe('127.0.0.1');
    const port = Number(url.port);
    expect(port).not.toBe(site.port);

    // Только loopback: на внешнем адресе машины порт прокси не отвечает.
    const outside = externalIp();
    if (outside) expect(await accepts(port, outside)).toBe(false);
    expect(await accepts(port, '127.0.0.1')).toBe(true);

    // Разметка: исходник плюс ОДИН тег сразу после <head>; запрет рамки снят.
    const original = await raw(site.port, '/');
    const page = await raw(port, '/');
    expect(page.status).toBe(200);
    const html = page.body.toString('utf8');
    expect(html.split(PICK_SCRIPT_PATH).length - 1).toBe(1);
    const at = original.body.toString('utf8').indexOf('<head>') + '<head>'.length;
    const src = original.body.toString('utf8');
    expect(html).toBe(`${src.slice(0, at)}${PICK_TAG}${src.slice(at)}`);
    expect(Number(page.headers['content-length'])).toBe(page.body.length);
    expect(page.headers['x-frame-options']).toBeUndefined();

    // JS: те же байты, что у сайта, хотя в нём есть строка `<head>`.
    const js = await raw(port, '/app.js');
    const jsOriginal = await raw(site.port, '/app.js');
    expect(js.body.equals(jsOriginal.body)).toBe(true);
    expect(js.body.includes(PICK_SCRIPT_PATH)).toBe(false);

    // Сжатая разметка распакована и получила тот же один тег.
    const gz = await raw(port, '/gz');
    expect(gz.headers['content-encoding']).toBeUndefined();
    expect(gz.body.toString('utf8')).toBe(`<html>${PICK_TAG}<body>gz page</body></html>`);
    expect(gunzipSync((await raw(site.port, '/gz')).body).toString()).toContain('gz page');

    // Цель видит свой Host и запрос без сжатия; редирект на цель указывает на прокси.
    const seen = JSON.parse(
      (await raw(port, '/seen', { 'accept-encoding': 'gzip' })).body.toString(),
    );
    expect(seen).toEqual({ host: `localhost:${site.port}`, encoding: null });
    const redirect = await raw(port, '/redirect');
    expect(redirect.headers.location).toBe(`http://127.0.0.1:${port}/`);

    // Скрипт выбора — с прокси, со своим nonce; сайту путь не передаётся.
    const script = await raw(port, PICK_SCRIPT_PATH);
    expect(script.status).toBe(200);
    expect(script.body.toString()).toContain(JSON.stringify(preview.nonce));

    // WebSocket (как HMR): слово туда и обратно.
    expect(await wsRoundTrip(`ws://127.0.0.1:${port}/hmr`, 'ping-hmr')).toBe('ping-hmr');

    // Не открытый прокси: чужое имя хоста, абсолютный адрес, чужой origin у WebSocket — отказ.
    expect((await raw(port, '/', { host: 'evil.example.com' })).status).toBe(403);
    expect((await raw(port, '/', { host: `evil.example.com:${port}` })).status).toBe(403);
    expect((await raw(port, `http://localhost:${site.port}/`)).status).toBe(403);
    expect((await raw(port, 'http://example.com/')).status).toBe(403);
    await expect(
      wsRoundTrip(`ws://127.0.0.1:${port}/hmr`, 'x', 'http://evil.example.com'),
    ).rejects.toThrow();

    // То же окно второй раз — тот же прокси и nonce, второго порта нет.
    const again = (await open(site.dir)).json<SitePreview>();
    expect(again).toEqual(preview);
  });

  it('открывает только запущенное панелью: чужой путь — 404, не прокси', async () => {
    const reply = await open(join(root, 'never-started'));
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual({ code: 'site-not-running' });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/site-preview',
      payload: { url: 'http://example.com' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('выбор: чужой nonce — 403; свой — секрет замаскирован, адрес переписан на dev-сервер', async () => {
    const site = await startSite('site-pick');
    const preview = (await open(site.dir)).json<SitePreview>();
    const proxyOrigin = new URL(preview.url).origin;
    const pick: PickPayload = {
      type: PICK_MESSAGE_TYPE,
      nonce: preview.nonce,
      selector: 'section > button:nth-of-type(2)',
      tag: 'button',
      text: `Pay ${SECRET}`,
      outerHTML: `<button data-token="${SECRET}">Pay</button>`,
      rect: { x: 1, y: 2, width: 3, height: 4 },
      url: `${proxyOrigin}/checkout?step=2`,
    };
    const url = `/api/site-preview/${preview.siteId}/pick`;
    const wrong = await app.inject({
      method: 'POST',
      url,
      payload: { ...pick, nonce: 'x'.repeat(32) },
    });
    expect(wrong.statusCode).toBe(403);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/site-preview/nope/pick',
      payload: pick,
    });
    expect(unknown.statusCode).toBe(404);

    const accepted = await app.inject({ method: 'POST', url, payload: pick });
    expect(accepted.statusCode).toBe(200);
    const masked = accepted.json<PickPayload>();
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.outerHTML).toMatch(/^<button data-token="[^"]+">Pay<\/button>$/);
    expect(masked.url).toBe(`http://localhost:${site.port}/checkout?step=2`);
  });

  it('выбор: секрет в адресе своего сайта и в селекторе тоже замаскирован, адрес — на dev-сервер', async () => {
    const site = await startSite('site-pick-url');
    const preview = (await open(site.dir)).json<SitePreview>();
    const proxyOrigin = new URL(preview.url).origin;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/site-preview/${preview.siteId}/pick`,
      payload: {
        type: PICK_MESSAGE_TYPE,
        nonce: preview.nonce,
        selector: `#${SECRET}`,
        tag: 'a',
        text: 'Сбросить пароль',
        outerHTML: '<a>Сбросить пароль</a>',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        url: `${proxyOrigin}/reset?token=${SECRET}`,
      } satisfies PickPayload,
    });
    expect(accepted.statusCode).toBe(200);
    const masked = accepted.json<PickPayload>();
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.url.startsWith(`http://localhost:${site.port}/reset?token=`)).toBe(true);
  });

  it('запуск остановлен или упал — прокси закрыт', async () => {
    const stopped = await startSite('site-stop');
    const first = new URL((await open(stopped.dir)).json<SitePreview>().url);
    expect(await accepts(Number(first.port))).toBe(true);
    registry.stop({ projectPath: stopped.dir });
    expect(await until(async () => !(await accepts(Number(first.port))), 5000)).toBe(true);
    expect((await open(stopped.dir)).statusCode).toBe(404);

    const crashed = await startSite('site-crash');
    const second = new URL((await open(crashed.dir)).json<SitePreview>().url);
    expect(await accepts(Number(second.port))).toBe(true);
    await raw(crashed.port, '/die');
    expect(await until(async () => !(await accepts(Number(second.port))), 10_000)).toBe(true);
  });
});
