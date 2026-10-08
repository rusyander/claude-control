import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../providers/registry.ts';
import { runAssistant, type RunAssistantDeps } from './assistant-runner.ts';

/**
 * Переключатель «Claude → локальная модель» (08.10): окно ассистента и служебные
 * вызовы групп запускают `claude -p` лёгким окном. Без переменных переключателя
 * такой вызов уходил в облако и падал «Not logged in», хотя помощник, агент
 * панели и наблюдатель уже шли в локальную модель. Проверка — на окружении,
 * с которым запущен процесс, а не на объекте маршрута.
 */
function fakeSpawn() {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const fn = ((cmd: string, args: string[], options?: { env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: options?.env });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.stdin = { on: () => {}, write: () => {}, end: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      (child.stdout as EventEmitter).emit('data', Buffer.from('готово'));
      child.emit('close', 0);
    }, 0);
    return child;
  }) as unknown as RunAssistantDeps['spawnImpl'];
  return { fn, calls };
}

const SWITCH = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5199', ANTHROPIC_API_KEY: '' };

describe('ассистент и группы при включённом переключателе Claude', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-assist-switch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('процесс claude получает адрес локальной модели', async () => {
    const spawn = fakeSpawn();
    const res = await runAssistant(getProvider('claude'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: (command) => command.startsWith('claude'),
      spawnImpl: spawn.fn,
      claudeEnv: () => SWITCH,
      model: 'haiku',
    });
    expect(res.ok).toBe(true);
    expect(spawn.calls[0]!.env).toMatchObject(SWITCH);
    // Ключ облака переключатель гасит пустой строкой — она обязана дойти как есть.
    expect(spawn.calls[0]!.env!.ANTHROPIC_API_KEY).toBe('');
  });

  it('переключатель выключен — окружение сервера, без добавок', async () => {
    const spawn = fakeSpawn();
    await runAssistant(getProvider('claude'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: (command) => command.startsWith('claude'),
      spawnImpl: spawn.fn,
      claudeEnv: () => ({}),
    });
    expect(spawn.calls[0]!.env?.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
  });

  it('чужой CLI переменных переключателя Claude не получает', async () => {
    const spawn = fakeSpawn();
    await runAssistant(getProvider('codex'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: (command) => command.startsWith('codex'),
      spawnImpl: spawn.fn,
      claudeEnv: () => SWITCH,
    });
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.env?.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
  });
});
