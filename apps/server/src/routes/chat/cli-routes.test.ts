import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CliInfo } from '@agentdeck/contracts';
import type { CliExec } from '../../providers/cli-install.ts';
import { registerChatCliRoutes } from './cli-routes.ts';

/**
 * Строка «Запускается … / Обновить CLI» — про CLI АКТИВНОГО провайдера. Запуск
 * процессов подменён: `where`/`which` знает только qwen, `--version` отвечает как
 * qwen 0.25.0, `update` пишется в журнал вызовов.
 */
const QWEN_PATH = process.platform === 'win32' ? 'C:\\bin\\qwen.cmd' : '/bin/qwen';
const calls: string[][] = [];
const exec: CliExec = (file, args) => {
  calls.push([file, ...args]);
  if (file === 'where' || file === 'which') {
    const name = args[args.length - 1] ?? '';
    return name.startsWith('qwen')
      ? { status: 0, stdout: `${QWEN_PATH}\n` }
      : { status: 1, stdout: '' };
  }
  if (args[0] === '--version') return { status: 0, stdout: '0.25.0\n' };
  return { status: 0, stdout: 'updated' };
};

describe('/api/chat/cli по активному провайдеру', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    calls.length = 0;
    await app.close();
  });

  const boot = async (provider: string): Promise<FastifyInstance> => {
    app = Fastify();
    registerChatCliRoutes(app, exec, () => ({ getSettings: () => ({ provider }) }));
    await app.ready();
    return app;
  };

  it('Qwen активен: путь и версия qwen, подпись Qwen Code, обновление `qwen update`', async () => {
    await boot('qwen');
    const info = (await app.inject({ url: '/api/chat/cli' })).json<CliInfo>();
    expect(info).toMatchObject({
      path: QWEN_PATH,
      version: '0.25.0',
      providerId: 'qwen',
      providerName: 'Qwen Code',
      canUpdate: true,
    });
    const update = await app.inject({ method: 'POST', url: '/api/chat/cli/update' });
    expect(update.statusCode).toBe(200);
    expect(calls).toContainEqual([QWEN_PATH, 'update']);
  });

  it('явный ?provider=claude (чат Claude): claude не найден — без подмены на qwen', async () => {
    await boot('qwen');
    const info = (await app.inject({ url: '/api/chat/cli?provider=claude' })).json<CliInfo>();
    expect(info.providerId).toBe('claude');
    expect(info.path).toBeUndefined();
  });

  it('CLI без проверенной подкоманды обновления — 409 с кодом, процесс не запускается', async () => {
    await boot('gemini');
    const update = await app.inject({ method: 'POST', url: '/api/chat/cli/update' });
    expect(update.statusCode).toBe(409);
    expect(update.json()).toMatchObject({ messageCode: 'cli-update-unsupported' });
    expect(calls.some((call) => call.includes('update'))).toBe(false);
  });
});

/**
 * Подкоманды обновления чужих CLI — сверены с `--help` самих CLI (goose 1.53.0,
 * Kimi Code 2.1.1, opencode 1.18.34). Подменённый `where` знает КАЖДЫЙ CLI, так что
 * отказ у непроверенных — решение маршрута, а не «CLI не найден».
 */
describe('/api/chat/cli/update — подкоманды чужих CLI', () => {
  const PATH_OF = (name: string): string =>
    process.platform === 'win32' ? `C:\bin\${name}.exe` : `/bin/${name}`;
  const log: string[][] = [];
  const anyCli: CliExec = (file, args) => {
    log.push([file, ...args]);
    if (file === 'where' || file === 'which') {
      const name = (args[args.length - 1] ?? '').replace(/\.cmd$/i, '');
      return { status: 0, stdout: `${PATH_OF(name)}\n` };
    }
    if (args[0] === '--version') return { status: 0, stdout: '1.0.0\n' };
    return { status: 0, stdout: 'updated' };
  };
  let app: FastifyInstance;
  afterEach(async () => {
    log.length = 0;
    await app.close();
  });
  const boot = async (): Promise<FastifyInstance> => {
    app = Fastify();
    registerChatCliRoutes(app, anyCli, () => ({ getSettings: () => ({ provider: 'claude' }) }));
    await app.ready();
    return app;
  };

  it.each([
    ['goose', 'goose', ['update']],
    // Без -y Kimi Code ждёт подтверждения, а терминала у запуска из панели нет.
    ['kimi', 'kimi', ['update', '-y']],
    ['opencode', 'opencode', ['upgrade']],
  ] as const)('%s: кнопка есть, запускается ровно %s %j', async (provider, bin, argv) => {
    await boot();
    const info = (await app.inject({ url: `/api/chat/cli?provider=${provider}` })).json<CliInfo>();
    expect(info).toMatchObject({ providerId: provider, canUpdate: true });
    log.length = 0;
    const update = await app.inject({
      method: 'POST',
      url: `/api/chat/cli/update?provider=${provider}`,
    });
    expect(update.statusCode).toBe(200);
    const launches = log.filter((call) => call[0] === PATH_OF(bin) && call[1] !== '--version');
    expect(launches).toEqual([[PATH_OF(bin), ...argv]]);
  });

  it.each(['gemini', 'aider', 'continue', 'cursor'])(
    '%s: подкоманда не проверена — 409, кнопки нет, ни одного запуска',
    async (provider) => {
      await boot();
      const info = (
        await app.inject({ url: `/api/chat/cli?provider=${provider}` })
      ).json<CliInfo>();
      expect(info.canUpdate).toBe(false);
      log.length = 0;
      const update = await app.inject({
        method: 'POST',
        url: `/api/chat/cli/update?provider=${provider}`,
      });
      expect(update.statusCode).toBe(409);
      expect(update.json()).toMatchObject({ messageCode: 'cli-update-unsupported' });
      expect(log).toEqual([]);
    },
  );
});
