import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreHookCommand } from '../../../bootstrap/session-road/hook-file.ts';
import { currentOs } from '../../../platform/os-kind.ts';

/**
 * Стенд P81 для живых проверок переходников: подставное ядро за настоящим хуком ядра (внешняя
 * граница — HTTP) и подставной `git` в PATH сеанса. Ядро отказывает `git push`, прочее разрешает;
 * `git` пишет свои аргументы в метку — `status` в метке доказывает, что вызов доходит до команды
 * (проверка не пуста), `push` — утечка.
 */

export interface FakeCore {
  url: string;
  calls: { tool: string; command: string }[];
  close(): Promise<void>;
}

export function startFakeCore(): Promise<FakeCore> {
  const calls: FakeCore['calls'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url !== '/v1/session/hook') {
        res.writeHead(404).end('{}');
        return;
      }
      const call = JSON.parse(body) as { tool: string; input: { command?: string } };
      const command = String(call.input.command ?? '');
      calls.push({ tool: call.tool, command });
      const deny = /\bgit\b.*\bpush\b/.test(command);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          deny ? { allow: false, reason: 'publishing is the core step' } : { allow: true },
        ),
      );
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      done({
        url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
        calls,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    }),
  );
}

/** Подставной `git`: дописывает свои аргументы в метку и выходит 0. */
export function fakeGit(bin: string, marker: string): void {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'git.cmd'), `@echo off\r\necho %*>> "${marker}"\r\n`);
  } else {
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${marker}"\n`);
    chmodSync(join(bin, 'git'), 0o755);
  }
}

export function readMarker(marker: string): string {
  return existsSync(marker) ? readFileSync(marker, 'utf8') : '';
}

/** Настоящая команда хука ядра дороги сессии (`run.ts hook`) для каталога сеанса. */
export function realCoreHook(dir: string): string {
  const hook = coreHookCommand(
    dir,
    [process.execPath, '--experimental-strip-types', '--no-warnings'],
    currentOs(),
  );
  if (!hook.ok) throw new Error(hook.reason);
  return hook.command;
}
