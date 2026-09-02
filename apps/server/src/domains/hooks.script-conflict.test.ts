import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HookDraft } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { readHooks, upsertHook, HookScriptExistsError } from './hooks.ts';

/**
 * Имя файла из формы совпало с существующим скриптом. Раньше файл молча
 * перезаписывался (с копией, но молча): пресеты называются как популярные
 * хуки — «Брифинг при старте» на машине, где давно лежит свой session-brief.mjs,
 * подменял его шаблоном. Теперь создание отвергается, а перегенерация
 * собственного файла правимого хука по-прежнему разрешена.
 */
describe('upsertHook — имя скрипта занято', () => {
  let dir: string;
  let settingsPath: string;
  let hooksDir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hook-conflict-'));
    settingsPath = join(dir, 'settings.json');
    hooksDir = join(dir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
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
    writeFileSync(settingsPath, '{}');
    writeFileSync(join(hooksDir, 'session-brief.mjs'), '// ORIGINAL\n');
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const draft = (over: Partial<HookDraft>): HookDraft => ({
    event: 'SessionStart',
    matchers: [],
    isEnabled: true,
    groupIds: [],
    template: 'message',
    message: 'привет',
    guardPatterns: [],
    command: '',
    ...over,
  });

  it('создание с занятым именем → 409, файл и settings.json не тронуты', () => {
    let thrown: unknown;
    try {
      upsertHook(settingsPath, hooksDir, null, draft({ scriptName: 'session-brief' }), store);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HookScriptExistsError);
    expect(thrown).toMatchObject({ statusCode: 409, code: 'script_exists' });
    expect(readFileSync(join(hooksDir, 'session-brief.mjs'), 'utf8')).toBe('// ORIGINAL\n');
    expect(readHooks(settingsPath, store)).toHaveLength(0);
  });

  it('расширение и регистр не обходят проверку', () => {
    expect(() =>
      upsertHook(settingsPath, hooksDir, null, draft({ scriptName: 'session-brief.mjs' }), store),
    ).toThrow(HookScriptExistsError);
    expect(readFileSync(join(hooksDir, 'session-brief.mjs'), 'utf8')).toBe('// ORIGINAL\n');
  });

  it('собственный файл правимого хука перегенерируется', () => {
    upsertHook(settingsPath, hooksDir, null, draft({ scriptName: 'own-hook' }), store);
    const [hook] = readHooks(settingsPath, store);
    expect(hook?.scriptPath).toBeDefined();
    expect(existsSync(join(hooksDir, 'own-hook.mjs'))).toBe(true);

    upsertHook(
      settingsPath,
      hooksDir,
      hook!.id,
      draft({ scriptName: 'own-hook', message: 'обновлено' }),
      store,
    );

    expect(readFileSync(join(hooksDir, 'own-hook.mjs'), 'utf8')).toContain('обновлено');
    expect(readHooks(settingsPath, store)).toHaveLength(1);
  });

  it('описание карточки — только первый блок шапки, без служебной строки', () => {
    upsertHook(
      settingsPath,
      hooksDir,
      null,
      draft({ scriptName: 'described', description: 'Проба описания' }),
      store,
    );
    expect(readHooks(settingsPath, store)[0]?.description).toBe('Проба описания');

    // Файл, созданный панелью раньше: служебная строка шла сразу за описанием.
    writeFileSync(
      join(hooksDir, 'legacy.mjs'),
      '// Старое описание\n// Событие: Stop. Файл создан через Claude Control, его можно свободно править.\n\nprocess.exit(0);\n',
    );
    upsertHook(
      settingsPath,
      hooksDir,
      null,
      draft({
        event: 'Stop',
        command: `node "${join(hooksDir, 'legacy.mjs').replace(/\\/g, '/')}"`,
      }),
      store,
    );
    expect(readHooks(settingsPath, store).find((h) => h.event === 'Stop')?.description).toBe(
      'Старое описание',
    );
  });
});
