import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Hook } from '@claude-control/contracts';
import { AppStore } from './app-store.ts';
import { hookContentId } from './hook-id.ts';

/**
 * Живучесть хранилища состояния: панель обязана подниматься на испорченном
 * state.json, а снимки выключенных хуков — находиться и удаляться независимо
 * от того, под каким id их когда-то записали.
 */
describe('AppStore: живучесть', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-store-res-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('битый state.json не роняет старт: дефолты + файл отложен в сторону', () => {
    // Обрыв питания посреди записи или правка руками. Раньше разбор бросал из
    // конструктора — сервер не поднимался вовсе, и починить было нечем.
    writeFileSync(join(dir, 'state.json'), '{"groups": [ {"id": "a"');

    const store = new AppStore(dir);

    expect(store.getGroups()).toEqual([]);
    expect(store.getSettings().theme).toBe('system');
    expect(existsSync(join(dir, 'state.corrupt.json'))).toBe(true);
    // Испорченный файл сохранён как есть: из него ещё можно вытащить группы руками.
    expect(readFileSync(join(dir, 'state.corrupt.json'), 'utf8')).toContain('"groups"');
  });

  it('пустой state.json — обычный случай, а не ошибка', () => {
    writeFileSync(join(dir, 'state.json'), '');
    expect(new AppStore(dir).getGroups()).toEqual([]);
  });

  describe('снимки выключенных хуков', () => {
    const hook = (over: Partial<Hook> = {}): Hook => ({
      id: 'PreToolUse:whatever',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'echo привет',
      isEnabled: false,
      groupIds: [],
      source: 'settings',
      ...over,
    });

    it('ключ снимка — содержательный id, а не тот, под которым хук показан', () => {
      const store = new AppStore(dir);
      // В списке дубль показан с суффиксом `-2`, локальная запись — с префиксом.
      store.rememberDisabledHook(hook({ id: 'PreToolUse:abcd1234-2' }));

      const saved = store.getDisabledHooks();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.id).toBe(hookContentId('PreToolUse', 'Bash', 'echo привет'));
    });

    it('снимок со старым позиционным ключом всё равно удаляется по содержанию', () => {
      // Регрессия: ключи вида `Stop:0:0` остались в состоянии с прошлых версий.
      // По ключу они не совпадали ни с чем, жили вечно — и стоило поправить
      // команду хука в файле, как снимок возвращался в список вторым,
      // «включённым» экземпляром и снова уезжал в settings.json.
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ disabledHooks: { 'PreToolUse:0:0': hook() } }),
      );
      const store = new AppStore(dir);
      expect(store.getDisabledHooks()).toHaveLength(1);

      store.pruneDisabledHooks([hookContentId('PreToolUse', 'Bash', 'echo привет')]);

      expect(store.getDisabledHooks()).toEqual([]);
    });

    it('чужие снимки очистка не трогает', () => {
      const store = new AppStore(dir);
      store.rememberDisabledHook(hook());
      store.rememberDisabledHook(hook({ command: 'echo другое' }));

      store.pruneDisabledHooks([hookContentId('PreToolUse', 'Bash', 'echo привет')]);

      expect(store.getDisabledHooks().map((item) => item.command)).toEqual(['echo другое']);
    });
  });
});
