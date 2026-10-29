import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngine, type EngineHandle } from '../container-engine.ts';

/**
 * Подставной сокет движка (P58 «int socket stub»): настоящий CLI `docker` говорит с ним по
 * `DOCKER_HOST` — именованный канал на Windows, unix-сокет на POSIX. Отвечает `_ping`, `version`
 * (Docker или Podman — по `kind`) и томами (`volumes/*`), запоминает запросы. Не подменяет CLI:
 * проверяется настоящий разбор вывода настоящего клиента.
 */

export interface EngineStub {
  host: string;
  requests: string[];
  volumes: Map<string, Record<string, string>>;
  close(): Promise<void>;
}

const PODMAN_VERSION = {
  Platform: { Name: '' },
  Version: '5.2.0',
  ApiVersion: '1.41',
  MinAPIVersion: '1.24',
  Os: 'linux',
  Arch: 'amd64',
  Components: [{ Name: 'Podman Engine', Version: '5.2.0' }],
};

const DOCKER_VERSION = {
  Platform: { Name: 'Docker Engine - Community' },
  Version: '27.0.1',
  ApiVersion: '1.41',
  MinAPIVersion: '1.24',
  Os: 'linux',
  Arch: 'amd64',
  Components: [{ Name: 'Engine', Version: '27.0.1' }],
};

/** Адрес мёртвого сокета той же формы (сервера нет — «ВМ остановлена»). */
export function deadSocket(tag: string): string {
  return process.platform === 'win32'
    ? `npipe:////./pipe/agentdeck-dead-${tag}-${process.pid}`
    : `unix://${join(tmpdir(), `agentdeck-dead-${tag}-${process.pid}.sock`)}`;
}

export async function startEngineStub(kind: 'podman' | 'docker'): Promise<EngineStub> {
  const requests: string[] = [];
  const volumes = new Map<string, Record<string, string>>();
  const dir =
    process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'agentdeck-engine-'));
  const name = `agentdeck-engine-stub-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const listenPath = dir ? join(dir, 'engine.sock') : `\\\\.\\pipe\\${name}`;
  const host = dir ? `unix://${listenPath}` : `npipe:////./pipe/${name}`;
  const server: Server = createServer((req, res) => {
    const url = (req.url ?? '').replace(/^\/v[\d.]+/, '');
    requests.push(`${req.method} ${url}`);
    res.setHeader('Api-Version', '1.41');
    res.setHeader('Content-Type', 'application/json');
    const send = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      if (url.startsWith('/_ping')) return send(200, 'OK');
      if (url.startsWith('/version'))
        return send(200, kind === 'podman' ? PODMAN_VERSION : DOCKER_VERSION);
      if (url.startsWith('/volumes/create') && req.method === 'POST') {
        const body = JSON.parse(raw || '{}') as { Name?: string; Labels?: Record<string, string> };
        const vol = body.Name ?? 'anon';
        volumes.set(vol, body.Labels ?? {});
        return send(201, {
          Name: vol,
          Labels: body.Labels ?? {},
          Driver: 'local',
          Mountpoint: '/x',
        });
      }
      const m = /^\/volumes\/([^/?]+)/.exec(url);
      if (m) {
        const vol = decodeURIComponent(m[1] as string);
        const labels = volumes.get(vol);
        if (!labels) return send(404, { message: `no such volume: ${vol}` });
        if (req.method === 'DELETE') {
          volumes.delete(vol);
          return send(204, '');
        }
        return send(200, { Name: vol, Labels: labels, Driver: 'local', Mountpoint: '/x' });
      }
      return send(404, { message: `stub: ${req.method} ${url} not modelled` });
    });
  });
  await new Promise<void>((done) => server.listen(listenPath, done));
  return {
    host,
    requests,
    volumes,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          if (dir) rmSync(dir, { recursive: true, force: true });
          done();
        });
      }),
  };
}

/** Образы postgres, годные для интеграционных тестов: первый, который движок реально читает. */
export const PG_CANDIDATES = ['postgres:15-alpine', 'postgres:16-alpine', 'postgres:17-alpine'];

/**
 * Первый локальный образ из списка по `image inspect`, не по `docker images`: тег в списке
 * бывает без содержимого (замер 29.10: `postgres:15-alpine` в списке, inspect — «No such image»).
 * Тянуть образ тест не станет — сеть и чужие теги не трогаются.
 */
export async function localImageOf(
  h: EngineHandle,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const image of candidates) {
    if ((await runEngine(h, ['image', 'inspect', '--format', '{{.Id}}', image])).ok) return image;
  }
  return undefined;
}
