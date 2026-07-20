import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { readHooks, moveHook } from './hooks.ts';

/**
 * Перестановка хуков внутри одного события. Ключевое:
 *   - порядок в файле равен порядку в списке, moveHook меняет соседей местами;
 *   - id контентный, поэтому перестановка НЕ сдвигает идентификаторы, а с ними
 *     и отметки «выключено»/участие в группах (в отличие от старых позиционных);
 *   - двигаемся только среди включённых хуков того же события того же файла.
 *
 * Отдельно проверяется взаимодействие с settings.local.json: панель обещает
 * его не править — см. находку про побочное создание пустого файла.
 */
function seedState(dir: string): void {
  const appDataDir = join(dir, 'claude-control');
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(
    join(appDataDir, 'state.json'),
    JSON.stringify({
      groups: [],
      automations: [],
      disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
    }),
  );
}

describe('moveHook — перестановка хуков', () => {
  let dir: string;
  let settingsPath: string;
  let localPath: string;
  let store: AppStore;

  const commandsInFile = (path = settingsPath): string[] => {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    return (saved.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hooks-move-'));
    settingsPath = join(dir, 'settings.json');
    localPath = join(dir, 'settings.local.json');
    seedState(dir);
    store = new AppStore(join(dir, 'claude-control'));

    // Три хука одного события, у каждого свой matcher — порядок легко читается.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'A', hooks: [{ type: 'command', command: 'echo a' }] },
            { matcher: 'B', hooks: [{ type: 'command', command: 'echo b' }] },
            { matcher: 'C', hooks: [{ type: 'command', command: 'echo c' }] },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('двигает хук вниз, меняя его местами с соседом', () => {
    const b = readHooks(settingsPath, store).find((h) => h.command === 'echo b')!;

    moveHook(settingsPath, store, b.id, 'down');

    expect(commandsInFile()).toEqual(['echo a', 'echo c', 'echo b']);
  });

  it('двигает хук вверх', () => {
    const c = readHooks(settingsPath, store).find((h) => h.command === 'echo c')!;

    moveHook(settingsPath, store, c.id, 'up');

    expect(commandsInFile()).toEqual(['echo a', 'echo c', 'echo b']);
  });

  it('id хука не меняется при перестановке — отметки и группы остаются на месте', () => {
    const before = readHooks(settingsPath, store);
    const b = before.find((h) => h.command === 'echo b')!;
    const idBefore = b.id;

    moveHook(settingsPath, store, b.id, 'down');

    const after = readHooks(settingsPath, store).find((h) => h.command === 'echo b')!;
    // id вычисляется от содержимого, значит переезд не сдвинул его.
    expect(after.id).toBe(idBefore);
  });

  it('крайний хук не уезжает за границу (наверх от первого — no-op)', () => {
    const a = readHooks(settingsPath, store).find((h) => h.command === 'echo a')!;

    moveHook(settingsPath, store, a.id, 'up');

    expect(commandsInFile()).toEqual(['echo a', 'echo b', 'echo c']);
  });

  it('выключенный хук не двигается (его нет в файле)', () => {
    const b = readHooks(settingsPath, store).find((h) => h.command === 'echo b')!;
    store.setEnabled('hook', b.id, false);

    const backup = moveHook(settingsPath, store, b.id, 'down');

    // Ничего не переставлено: выключенный хук вне порядка файла.
    expect(backup).toBeUndefined();
  });

  it('возвращает путь резервной копии при указанном backupDir', () => {
    const backupDir = join(dir, 'backups');
    const b = readHooks(settingsPath, store).find((h) => h.command === 'echo b')!;

    const backup = moveHook(settingsPath, store, b.id, 'down', backupDir);

    expect(backup).toBeTypeOf('string');
    expect(existsSync(backup as string)).toBe(true);
  });

  /**
   * BUG (см. .agent/tmp/audit-config.md → BUG-2). moveHook безусловно пишет в
   * localPath, если он передан. При перестановке ГЛОБАЛЬНОГО хука это создаёт
   * пустой settings.local.json ({"hooks":{}}), хотя файла не было и локальные
   * хуки не затрагивались. Панель декларирует, что локальный файл не правит.
   * Тест фиксирует ЖЕЛАЕМОЕ поведение и включится после фикса.
   */
  it('перестановка глобального хука НЕ создаёт settings.local.json (BUG-2)', () => {
    const b = readHooks(settingsPath, store, localPath).find((h) => h.command === 'echo b')!;
    expect(existsSync(localPath)).toBe(false);

    moveHook(settingsPath, store, b.id, 'down', undefined, localPath);

    expect(existsSync(localPath)).toBe(false);
  });

  it('перестановка глобального хука пишет только в settings.json, локальный не трогает (BUG-2)', () => {
    // Локальный файл существует и содержит свой хук — он не должен быть переписан.
    writeFileSync(
      localPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'L', hooks: [{ type: 'command', command: 'echo l' }] }] },
      }),
    );
    const localBefore = readFileSync(localPath, 'utf8');

    const b = readHooks(settingsPath, store, localPath).find((h) => h.command === 'echo b')!;
    moveHook(settingsPath, store, b.id, 'down', undefined, localPath);

    // Глобальный порядок изменился…
    expect(commandsInFile()).toEqual(['echo a', 'echo c', 'echo b']);
    // …а локальный файл остался байт в байт прежним.
    expect(readFileSync(localPath, 'utf8')).toBe(localBefore);
  });
});
