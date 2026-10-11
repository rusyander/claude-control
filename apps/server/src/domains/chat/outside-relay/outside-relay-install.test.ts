import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { readHooks, writeHooks } from '../../hooks/hooks.ts';
import {
  installRelayHooks,
  relayHookCommand,
  relayHooksStatus,
  RELAY_HOOK_FILE,
  uninstallRelayHooks,
} from './outside-relay-install.ts';

/**
 * Хуки пересылки в настройках Claude Code. Ошибка здесь бьёт по чужим сессиям
 * человека: лишний хук отвечает дважды, пропавший — молча выключает телефон,
 * а затёртый чужой хук — потерянная работа человека. Всё — на временном файле.
 */

describe('Хуки пересылки в settings.json', () => {
  let dir: string;
  let settings: string;
  let backups: string;
  let store: AppStore;
  const command = relayHookCommand('http://127.0.0.1:5178', 'C:/token');

  const raw = (): { hooks?: Record<string, unknown[]>; model?: string } =>
    JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, unknown[]> };
  const ours = () =>
    readHooks(settings, store).filter((hook) => hook.command.includes(RELAY_HOOK_FILE));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-relay-install-'));
    settings = join(dir, 'settings.json');
    backups = join(dir, 'backups');
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    store = new AppStore(join(dir, 'agentdeck'));
    writeFileSync(
      settings,
      JSON.stringify({
        model: 'opus',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo свой' }] }] },
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ставит три хука, не трогая чужой хук и прочие настройки, с резервной копией', () => {
    expect(relayHooksStatus(settings, store)).toEqual({ installed: false, shortTimeout: false });
    expect(installRelayHooks(settings, store, command, backups)).toBe(true);

    expect(
      ours()
        .map((hook) => [hook.event, hook.matcher, hook.timeout])
        .sort(),
    ).toEqual([
      ['PermissionRequest', '*', 3600],
      ['PostToolUse', '*', 10],
      ['Stop', undefined, 10],
    ]);
    expect(readHooks(settings, store).some((hook) => hook.command === 'echo свой')).toBe(true);
    expect(raw().model).toBe('opus');
    expect(readdirSync(backups).length).toBeGreaterThan(0);
    expect(relayHooksStatus(settings, store)).toEqual({ installed: true, shortTimeout: false });
  });

  it('повторная установка того же — файл не переписывается', () => {
    installRelayHooks(settings, store, command, backups);
    const before = readFileSync(settings, 'utf8');
    expect(installRelayHooks(settings, store, command, backups)).toBe(false);
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it('другой адрес панели и прежний PreToolUse для вопросов заменяются, не копятся', () => {
    const old = relayHookCommand('http://127.0.0.1:9999', 'C:/token');
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'AskUserQuestion',
              hooks: [{ type: 'command', command: old, timeout: 3600 }],
            },
          ],
          Stop: [{ hooks: [{ type: 'command', command: old, timeout: 10 }] }],
        },
      }),
    );
    expect(installRelayHooks(settings, store, command)).toBe(true);
    expect(
      ours()
        .map((hook) => hook.event)
        .sort(),
    ).toEqual(['PermissionRequest', 'PostToolUse', 'Stop']);
    expect(ours().every((hook) => hook.command === command)).toBe(true);
    expect(raw().hooks?.PreToolUse).toBeUndefined();
  });

  it('хук прав с коротким таймаутом виден как «короткий»', () => {
    installRelayHooks(settings, store, command);
    const hooks = readHooks(settings, store).map((hook) =>
      hook.event === 'PermissionRequest' && hook.command === command
        ? { ...hook, timeout: 60 }
        : hook,
    );
    writeHooks(settings, hooks);
    expect(relayHooksStatus(settings, store).shortTimeout).toBe(true);
  });

  it('хук, выключенный человеком в «Хуках», обратно не включается', () => {
    installRelayHooks(settings, store, command);
    const permission = ours().find((hook) => hook.event === 'PermissionRequest')!;
    store.rememberDisabledHook(permission);
    store.setEnabled('hook', permission.id, false, permission.legacyId);
    writeHooks(
      settings,
      readHooks(settings, store).map((hook) =>
        hook.id === permission.id ? { ...hook, isEnabled: false } : hook,
      ),
    );

    expect(installRelayHooks(settings, store, command)).toBe(false);
    expect(raw().hooks?.PermissionRequest).toBeUndefined();
    expect(relayHooksStatus(settings, store).installed).toBe(false);
  });

  it('снятие убирает только хуки пересылки', () => {
    installRelayHooks(settings, store, command);
    expect(uninstallRelayHooks(settings, store, backups)).toBe(true);
    expect(ours()).toEqual([]);
    expect(readHooks(settings, store).map((hook) => hook.command)).toEqual(['echo свой']);
    expect(uninstallRelayHooks(settings, store, backups)).toBe(false);
  });
});
