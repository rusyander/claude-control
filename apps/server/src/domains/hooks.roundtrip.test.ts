import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import { applyEntityState, rewriteHooks } from './entity-toggle.ts';
import { promotePathStep } from './groups/promote.ts';
import { moveHook, readHooks, upsertHook } from './hooks.ts';

/**
 * Ревью 28.09 (F-120): писатель хуков собирал каждую запись заново как
 * `{type:'command', command, timeout}` — prompt-хук становился командой без
 * команды, `statusMessage`/`async` пропадали. Проектный `settings.json` лежит
 * в гите проекта, общий — это конфиг владельца. Здесь оба — во временном каталоге.
 */

const PROMPT_STOP = { type: 'prompt', prompt: 'Check the task is complete', timeout: 30 };
const GUARD = {
  type: 'command',
  command: 'node guard.mjs',
  statusMessage: 'Guarding',
  async: true,
};

let dir: string;
let store: AppStore;

const deps = () => ({
  store,
  paths: {
    root: join(dir, 'claude'),
    appData: join(dir, 'claude', 'agentdeck'),
    settings: join(dir, 'claude', 'settings.json'),
    settingsLocal: join(dir, 'claude', 'settings.local.json'),
    claudeMd: join(dir, 'claude', 'CLAUDE.md'),
    secretsEnv: join(dir, 'claude', 'secrets.env'),
    skills: join(dir, 'claude', 'skills'),
    hooks: join(dir, 'claude', 'hooks'),
    mcpConfig: join(dir, 'claude', '.claude.json'),
  },
  backupDir: join(dir, 'claude', 'agentdeck', 'backups'),
});

type RawFile = { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> };
const readFile = (path: string): RawFile => JSON.parse(readFileSync(path, 'utf8')) as RawFile;
const seed = (path: string): void =>
  writeFileSync(
    path,
    JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [PROMPT_STOP] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [GUARD] }],
      },
    }),
    'utf8',
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-hooks-roundtrip-'));
  mkdirSync(join(dir, 'claude', 'agentdeck'), { recursive: true });
  store = new AppStore(join(dir, 'claude', 'agentdeck'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('F-120: «Сделать ресурсом» хук проектной группы', () => {
  it('prompt-хук и поля команды в проектном settings.json остаются как были', () => {
    const project = join(dir, 'proj');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const settings = join(project, '.claude', 'settings.json');
    seed(settings);
    const text = { ru: 'Проверка', en: 'Check' };
    const group: Group = store.saveGroup({
      id: 'proj-1',
      name: 'Flow',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      scope: { kind: 'project', path: project, provider: 'claude' },
      isEnabled: true,
      order: 0,
      path: {
        steps: [
          {
            id: 's1',
            order: 0,
            kind: 'prompt',
            anchor: 'work',
            title: text,
            prompt: text,
            source: 'ru',
            createdAt: '2026-09-28T00:00:00.000Z',
          },
        ],
      },
    });
    const draft = JSON.stringify({ event: 'PostToolUse', matcher: 'Edit', command: 'node x.mjs' });
    promotePathStep(deps(), group, { stepId: 's1', type: 'hook', draft });

    const saved = readFile(settings);
    expect(saved.hooks.Stop).toEqual([{ hooks: [PROMPT_STOP] }]);
    expect(saved.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [GUARD] }]);
    expect(saved.hooks.PostToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'node x.mjs' }] },
    ]);
    expect((saved as unknown as { model: string }).model).toBe('opus');
  });
});

describe('F-120: тот же писатель на общем settings.json (временном)', () => {
  it('выключить и включить prompt-хук — запись возвращается целиком', () => {
    const { paths } = deps();
    seed(paths.settings);
    const prompt = readHooks(paths.settings, store).find((hook) => hook.event === 'Stop');
    expect(prompt).toBeDefined();

    store.setEnabled('hook', prompt!.id, false);
    applyEntityState(deps(), 'hook', prompt!.id, false);
    rewriteHooks(deps());
    expect(readFile(paths.settings).hooks.Stop).toBeUndefined();

    // Снимок живёт в state.json — перечитываем хранилище, как после рестарта.
    store = new AppStore(join(dir, 'claude', 'agentdeck'));
    store.setEnabled('hook', prompt!.id, true);
    applyEntityState(deps(), 'hook', prompt!.id, true);
    rewriteHooks(deps());
    expect(readFile(paths.settings).hooks.Stop).toEqual([{ hooks: [PROMPT_STOP] }]);
    expect(readFile(paths.settings).hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [GUARD] },
    ]);
  });

  it('перестановка не теряет полей соседей', () => {
    const { paths } = deps();
    writeFileSync(
      paths.settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [GUARD] },
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo e', once: true }] },
          ],
        },
      }),
      'utf8',
    );
    const edit = readHooks(paths.settings, store).find((hook) => hook.matcher === 'Edit');
    moveHook(paths.settings, store, edit!.id, 'up', deps().backupDir);
    expect(readFile(paths.settings).hooks.PreToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo e', once: true }] },
      { matcher: 'Bash', hooks: [GUARD] },
    ]);
  });

  it('правка команды через форму сохраняет statusMessage/async командного хука', () => {
    const { paths } = deps();
    seed(paths.settings);
    const guard = readHooks(paths.settings, store).find((hook) => hook.event === 'PreToolUse');
    upsertHook(
      paths.settings,
      paths.hooks,
      guard!.id,
      {
        event: 'PreToolUse',
        matchers: ['Bash'],
        guardPatterns: [],
        groupIds: [],
        isEnabled: true,
        command: 'node guard2.mjs',
      },
      store,
      deps().backupDir,
    );
    const saved = readFile(paths.settings);
    expect(saved.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ ...GUARD, command: 'node guard2.mjs' }] },
    ]);
    expect(saved.hooks.Stop).toEqual([{ hooks: [PROMPT_STOP] }]);
  });
});
