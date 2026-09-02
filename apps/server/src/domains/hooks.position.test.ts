import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudePaths } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { readHooks } from './hooks.ts';
import { applyEntityState, rewriteHooks, type EntityToggleDeps } from './entity-toggle.ts';

/**
 * Выключение хука убирает его из settings.json, включение — возвращает. Раньше
 * возвращало в КОНЕЦ события: снимок помнил команду, но не место, и порядок,
 * выставленный стрелками «выше/ниже», терялся от одного щелчка тумблера.
 */
describe('hook toggle — позиция в событии', () => {
  let dir: string;
  let settingsPath: string;
  let store: AppStore;
  let deps: EntityToggleDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hook-pos-'));
    settingsPath = join(dir, 'settings.json');
    mkdirSync(join(dir, 'claude-control'), { recursive: true });
    writeFileSync(
      join(dir, 'claude-control', 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
        disabledHooks: {},
      }),
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node a.mjs' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: 'node b.mjs' }] },
            { hooks: [{ type: 'command', command: 'node c.mjs' }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'node z.mjs' }] }],
        },
      }),
    );
    store = new AppStore(join(dir, 'claude-control'));
    deps = {
      paths: {
        settings: settingsPath,
        settingsLocal: join(dir, 'settings.local.json'),
        hooks: join(dir, 'hooks'),
      } as unknown as ClaudePaths,
      store,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fileOrder = (): string[] =>
    (
      JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse as {
        hooks: { command: string }[];
      }[]
    ).flatMap((group) => group.hooks.map((hook) => hook.command));
  const idOf = (command: string): string =>
    readHooks(settingsPath, store).find((hook) => hook.command === command)!.id;

  /** То, что делает маршрут переключения: отметка, применение, перезапись. */
  const toggle = (command: string, isEnabled: boolean): void => {
    const id = idOf(command);
    store.setEnabled('hook', id, isEnabled);
    applyEntityState(deps, 'hook', id, isEnabled);
    rewriteHooks(deps);
  };

  it('первый хук события возвращается первым', () => {
    toggle('node a.mjs', false);
    expect(fileOrder()).toEqual(['node b.mjs', 'node c.mjs']);

    toggle('node a.mjs', true);
    expect(fileOrder()).toEqual(['node a.mjs', 'node b.mjs', 'node c.mjs']);
  });

  it('средний хук возвращается в середину', () => {
    toggle('node b.mjs', false);
    toggle('node b.mjs', true);
    expect(fileOrder()).toEqual(['node a.mjs', 'node b.mjs', 'node c.mjs']);
  });

  it('два выключенных подряд возвращаются в исходном порядке', () => {
    toggle('node a.mjs', false);
    toggle('node b.mjs', false);
    expect(fileOrder()).toEqual(['node c.mjs']);

    // Пока выключены, список панели держит их на своих местах.
    expect(
      readHooks(settingsPath, store)
        .filter((hook) => hook.event === 'PreToolUse')
        .map((hook) => hook.command),
    ).toEqual(['node a.mjs', 'node b.mjs', 'node c.mjs']);

    toggle('node b.mjs', true);
    toggle('node a.mjs', true);
    expect(fileOrder()).toEqual(['node a.mjs', 'node b.mjs', 'node c.mjs']);
  });

  it('снимок без позиции (прежние версии) встаёт в конец события, не в конец файла', () => {
    store.rememberDisabledHook({
      id: 'PreToolUse:old',
      event: 'PreToolUse',
      command: 'node old.mjs',
      isEnabled: false,
      groupIds: [],
      source: 'settings',
    });
    const commands = readHooks(settingsPath, store).map((hook) => hook.command);
    expect(commands).toEqual([
      'node a.mjs',
      'node b.mjs',
      'node c.mjs',
      'node old.mjs',
      'node z.mjs',
    ]);
  });
});
