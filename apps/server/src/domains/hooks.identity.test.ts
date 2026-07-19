import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHooks } from './hooks.ts';
import { AppStore } from '../lib/app-store.ts';

/**
 * Идентификаторы хуков перешли с позиционных (`Stop:0:0`) на контентные.
 *
 * Причина: позиция сдвигается. Удалили соседний хук — и все следующие поехали,
 * а вместе с ними уехали отметка «выключено», участие в группе и снимок
 * команды: настройка, сделанная одному хуку, оказывалась у другого.
 *
 * Вторая половина задачи — не потерять то, что уже настроено. Отметки в
 * state.json записаны по старым идентификаторам, поэтому они продолжают
 * находиться, пока не будут переписаны.
 */
describe('Идентификаторы хуков', () => {
  let dir: string;
  let settingsPath: string;
  let store: AppStore;

  const writeHooksFile = (commands: string[]): void => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: commands.map((command) => ({ type: 'command', command })) }],
        },
      }),
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hookid-'));
    settingsPath = join(dir, 'settings.json');
    mkdirSync(join(dir, 'claude-control'), { recursive: true });
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ГЛАВНОЕ: удаление соседа не меняет идентификатор хука', () => {
    writeHooksFile(['echo первый', 'echo второй', 'echo третий']);
    const before = readHooks(settingsPath, store).find((hook) => hook.command === 'echo третий');

    // Первый хук ушёл — прежде «третий» переехал бы с :0:2 на :0:1.
    writeHooksFile(['echo второй', 'echo третий']);
    const after = readHooks(settingsPath, store).find((hook) => hook.command === 'echo третий');

    expect(after?.id).toBe(before?.id);
    expect(after?.legacyId).not.toBe(before?.legacyId);
  });

  it('отметка «выключено» остаётся на своём хуке после удаления соседа', () => {
    writeHooksFile(['echo первый', 'echo второй']);
    const second = readHooks(settingsPath, store).find((hook) => hook.command === 'echo второй');
    store.setEnabled('hook', second!.id, false);

    writeHooksFile(['echo второй']);
    const hooks = readHooks(settingsPath, store);

    expect(hooks.find((hook) => hook.command === 'echo второй')?.isEnabled).toBe(false);
  });

  it('отметки со старыми идентификаторами продолжают действовать', () => {
    // Так выглядит state.json, записанный до перехода на новые id.
    writeHooksFile(['echo давний']);
    store.setEnabled('hook', 'PreToolUse:0:0', false);

    const [hook] = readHooks(settingsPath, store);

    expect(hook?.legacyId).toBe('PreToolUse:0:0');
    expect(hook?.isEnabled).toBe(false);
  });

  it('старая отметка убирается при первой же правке состояния', () => {
    writeHooksFile(['echo давний']);
    store.setEnabled('hook', 'PreToolUse:0:0', false);

    const [hook] = readHooks(settingsPath, store);
    store.setEnabled('hook', hook!.id, true, hook!.legacyId);

    expect(store.getState().disabled.hook).not.toContain('PreToolUse:0:0');
    expect(readHooks(settingsPath, store)[0]?.isEnabled).toBe(true);
  });

  it('состав группы со старыми идентификаторами не теряется', () => {
    writeHooksFile(['echo групповой']);
    store.saveGroup({
      id: 'g1',
      name: 'Набор',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'hook', id: 'PreToolUse:0:0' }],
      env: {},
      isEnabled: true,
      order: 0,
    });

    const [hook] = readHooks(settingsPath, store);

    expect(hook?.groupIds).toContain('g1');
  });

  it('полные дубли различаются суффиксом', () => {
    writeHooksFile(['echo одно и то же', 'echo одно и то же']);

    const ids = readHooks(settingsPath, store).map((hook) => hook.id);

    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toMatch(/-2$/);
  });

  it('идентификатор устойчив между чтениями', () => {
    writeHooksFile(['echo стабильный']);

    const first = readHooks(settingsPath, store)[0]?.id;
    const second = readHooks(settingsPath, store)[0]?.id;

    expect(first).toBe(second);
  });

  it('правка команды меняет идентификатор — это уже другой хук', () => {
    writeHooksFile(['echo было']);
    const before = readHooks(settingsPath, store)[0]?.id;

    writeHooksFile(['echo стало']);
    const after = readHooks(settingsPath, store)[0]?.id;

    expect(after).not.toBe(before);
  });
});
