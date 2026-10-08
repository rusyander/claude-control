import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { updateGroupSources } from '../../../lib/app-store/group-sources.ts';
import { hookContentId } from '../../../lib/hook-id.ts';
import { setGroupEnabled } from '../../group-toggle.ts';
import { readHooks } from '../../hooks/hooks.ts';
import { applyAdvice } from './advice.ts';

/**
 * Ревью 28.09 (F-114, сосед скилла): «улучшить» хук выключенной группы шло через
 * `writeHooks`, а тот выключенные хуки не пишет — новая команда не ложилась
 * никуда, участник группы уезжал на id, которого нет нигде, и после включения
 * группы хука не было вовсе. Всё во временном каталоге.
 */

let root: string;
let store: AppStore;

const deps = () => ({
  store,
  paths: {
    root,
    appData: join(root, 'agentdeck'),
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, 'secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '.claude.json'),
  },
  backupDir: join(root, 'agentdeck', 'backups'),
});

const OLD_ID = hookContentId('Stop', undefined, 'node old.mjs');
const NEW_ID = hookContentId('Stop', undefined, 'node new.mjs');

function group(id: string, order: number): Group {
  return store.saveGroup({
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [{ kind: 'hook', id: OLD_ID }],
    env: {},
    projectPaths: [],
    scope: { kind: 'global' },
    isEnabled: true,
    order,
  });
}

function seed(): Group {
  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node old.mjs' }] }] },
    }),
    'utf8',
  );
  const flow = group('glob-1', 0);
  updateGroupSources(join(root, 'agentdeck'), (state) => {
    state.advice[flow.id] = {
      mode: 'copy',
      items: [
        {
          kind: 'hook',
          id: OLD_ID,
          verdict: 'improve',
          reason: 'r',
          replacement: JSON.stringify({ event: 'Stop', command: 'node new.mjs' }),
        },
      ],
      at: '2026-09-28T00:00:00.000Z',
    };
  });
  return flow;
}

const commands = () => readHooks(join(root, 'settings.json'), store).map((hook) => hook.command);
const fileText = () => readFileSync(join(root, 'settings.json'), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-advice-disabled-hook-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('F-114: «улучшить» хук выключенной группы', () => {
  it('новая команда ложится снимком, остаётся выключенной и возвращается с группой', () => {
    const flow = seed();
    setGroupEnabled(deps(), flow, false);
    const off = store.getGroups().find((item) => item.id === flow.id)!;
    expect(fileText()).not.toContain('old.mjs');

    const saved = applyAdvice(deps(), off, [{ kind: 'hook', id: OLD_ID }]);

    expect(saved.members).toEqual([{ kind: 'hook', id: NEW_ID }]);
    expect(commands()).toEqual(['node new.mjs']);
    expect(readHooks(join(root, 'settings.json'), store)[0]?.isEnabled).toBe(false);
    expect(fileText()).not.toContain('new.mjs');

    setGroupEnabled(deps(), saved, true);
    expect(fileText()).toContain('node new.mjs');
    expect(fileText()).not.toContain('old.mjs');
    expect(store.getDisabledHooks()).toEqual([]);
    expect(commands()).toEqual(['node new.mjs']);
  });

  /**
   * F-114, сосед снятия (V-fix-A): «оставить наш» у копии выключенной группы
   * снимает скопированный хук. Его команда лежит снимком выключенных, а
   * `removeEntity` стирает отметку выключения — без чистки снимка хук читался
   * ВКЛЮЧЁННЫМ призраком, которого нет в файле, и следующая запись хуков
   * возвращала его в settings.json.
   */
  it('«оставить наш» у выключенной группы снимает и снимок скопированного хука', () => {
    const oursId = hookContentId('Stop', undefined, 'node ours.mjs');
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node old.mjs' }] },
            { hooks: [{ type: 'command', command: 'node ours.mjs' }] },
          ],
        },
      }),
      'utf8',
    );
    const flow = group('glob-1', 0);
    updateGroupSources(join(root, 'agentdeck'), (state) => {
      state.advice[flow.id] = {
        mode: 'copy',
        items: [{ kind: 'hook', id: OLD_ID, verdict: 'ours', reason: 'r', replacement: oursId }],
        at: '2026-09-28T00:00:00.000Z',
      };
    });
    setGroupEnabled(deps(), flow, false);
    const off = store.getGroups().find((item) => item.id === flow.id)!;

    const saved = applyAdvice(deps(), off, [{ kind: 'hook', id: OLD_ID }]);

    expect(saved.members).toEqual([{ kind: 'hook', id: oursId }]);
    expect(store.getDisabledHooks().map((hook) => hook.command)).not.toContain('node old.mjs');
    expect(commands()).toEqual(['node ours.mjs']);
    // Любая следующая запись хуков не возвращает снятый хук в файл.
    setGroupEnabled(deps(), saved, true);
    expect(fileText()).not.toContain('old.mjs');
    expect(commands()).toEqual(['node ours.mjs']);
  });

  it('включённый хук переписывается в файле, и другие группы с ним уезжают на новый id', () => {
    const flow = seed();
    group('glob-2', 1);

    applyAdvice(deps(), flow, [{ kind: 'hook', id: OLD_ID }]);

    expect(fileText()).toContain('node new.mjs');
    expect(fileText()).not.toContain('old.mjs');
    const other = store.getGroups().find((item) => item.id === 'glob-2')!;
    expect(other.members).toEqual([{ kind: 'hook', id: NEW_ID }]);
  });
});
