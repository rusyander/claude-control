import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { OutsideRelay } from '../../../domains/chat/outside-relay/outside-relay.ts';
import { RELAY_HOOK_FILE } from '../../../domains/chat/outside-relay/outside-relay-install.ts';
import { registerOutsideRelayRoutes, syncRelayHooks } from './outside-relay-routes.ts';

/**
 * Владелец 11.10: хуки пересылки — «из коробки». Переключатель и старт панели
 * сами приводят настройки Claude Code в соответствие: включено — три хука
 * стоят, выключено — сняты, чужие хуки человека целы. Всё — на временном файле.
 */

describe('Хуки пересылки следуют переключателю', () => {
  let dir: string;
  let settings: string;
  let store: AppStore;
  let ctx: ServerContext;
  let app: FastifyInstance;

  const relayEvents = (): string[] => {
    const hooks =
      (
        JSON.parse(readFileSync(settings, 'utf8')) as {
          hooks?: Record<string, { hooks: { command: string }[] }[]>;
        }
      ).hooks ?? {};
    return Object.entries(hooks)
      .filter(([, groups]) =>
        groups.some((group) => group.hooks.some((hook) => hook.command.includes(RELAY_HOOK_FILE))),
      )
      .map(([event]) => event)
      .sort();
  };
  const toggle = (enabled: boolean) =>
    app.inject({ method: 'PATCH', url: '/api/outside/relay', payload: { enabled } });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-relay-routes-'));
    settings = join(dir, 'settings.json');
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    store = new AppStore(join(dir, 'agentdeck'));
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] },
      }),
    );
    ctx = {
      location: { paths: { settings }, source: 'home', isValid: true },
      store,
      backupDir: undefined,
    } as unknown as ServerContext;
    app = Fastify();
    registerOutsideRelayRoutes(
      app,
      ctx,
      new OutsideRelay({ enabled: () => true, ownSession: () => false }),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('старт с включённой пересылкой вписывает три хука, чужой хук цел', () => {
    syncRelayHooks(ctx);
    expect(relayEvents()).toEqual(['PermissionRequest', 'PostToolUse', 'Stop']);
    expect(readFileSync(settings, 'utf8')).toContain('"mine"');
  });

  it('выключили — хуки сняты, включили — вернулись, состояние это говорит', async () => {
    syncRelayHooks(ctx);
    const off = await toggle(false);
    expect(off.json()).toMatchObject({ enabled: false, installed: false });
    expect(relayEvents()).toEqual([]);
    expect(readFileSync(settings, 'utf8')).toContain('"mine"');
    const on = await toggle(true);
    expect(on.json()).toMatchObject({ enabled: true, installed: true });
    expect(relayEvents()).toEqual(['PermissionRequest', 'PostToolUse', 'Stop']);
  });

  it('запись не удалась — ни старт, ни запрос не падают, состояние честное', async () => {
    // Каталог вместо файла: читатель настроек падает, как на битом диске.
    rmSync(settings);
    mkdirSync(settings);
    expect(() => syncRelayHooks(ctx)).not.toThrow();
    const on = await toggle(true);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ enabled: true, installed: false });
  });

  it('каталога Claude нет — ни старт, ни переключатель не создают ~/.claude', async () => {
    // Первый запуск без Claude Code (выбран другой CLI): `detectClaudeLocation`
    // отдаёт `not-found` с путями в несуществующий `~/.claude`.
    const absent = join(dir, 'no-claude');
    ctx.location = {
      paths: { settings: join(absent, 'settings.json') },
      source: 'not-found',
      isValid: false,
    } as unknown as ServerContext['location'];
    syncRelayHooks(ctx);
    const on = await toggle(true);
    expect(existsSync(absent)).toBe(false);
    expect(on.json()).toMatchObject({ enabled: true, installed: false });
  });
});
