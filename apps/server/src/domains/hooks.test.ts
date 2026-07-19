import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Hook, HookDraft } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { readHooks, writeHooks, upsertHook, deleteHook } from './hooks.ts';

/**
 * Полный state.json со свежими массивами — изолирует AppStore от процесс-глобального
 * DEFAULT_STATE (см. отчёт о баге shared-array в app-store.ts).
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

/**
 * Тесты хуков Claude Code. Ключевое здесь — верное разворачивание вложенной
 * структуры settings.json (событие → matcher-группы → команды) в плоский список
 * и сборка обратно ровно в том формате, который понимает Claude Code: если
 * структура matcher→hooks собьётся, живой конфиг перестанет работать.
 *
 * Всё пишется только во временный каталог из mkdtempSync — настоящий ~/.claude
 * не затрагивается. Каждый тест убирает свой каталог за собой.
 */
describe('hooks', () => {
  let dir: string;
  let settingsPath: string;
  let hooksDir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hooks-'));
    settingsPath = join(dir, 'settings.json');
    hooksDir = join(dir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(settingsPath, '{}');
    // Хранилище приложения (группы, отметки «выключено») живёт отдельным файлом.
    // ВАЖНО: засеваем полный state.json в каждый временный каталог. Без него
    // свежий AppStore разделяет массивы disabled/groups с модульным DEFAULT_STATE
    // по ссылке (баг в app-store.ts, см. отчёт), и setEnabled одного теста
    // протекает в остальные. Готовый файл заставляет load() взять свежие массивы.
    seedState(dir);
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Записать settings.json в родном для Claude Code вложенном формате. */
  const writeSettings = (settings: unknown) =>
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  /** Полноценный Hook из плоского списка — то, что отдаёт readHooks. */
  const makeHook = (partial: Partial<Hook> & Pick<Hook, 'event' | 'command'>): Hook => ({
    id: `${partial.event}:test`,
    matcher: undefined,
    isEnabled: true,
    groupIds: [],
    ...partial,
  });

  describe('readHooks — разворачивание settings.json в плоский список', () => {
    it('читает хуки из нескольких событий с разными matcher', () => {
      writeSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-bash' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: 'echo pre-write' }] },
          ],
          PostToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: 'echo post' }] }],
        },
      });

      const hooks = readHooks(settingsPath, store);

      expect(hooks).toHaveLength(3);
      // Каждое событие/группа/команда получает стабильный id вида event:group:command.
      const bash = hooks.find((h) => h.matcher === 'Bash');
      expect(bash?.id).toBe('PreToolUse:0:0');
      expect(bash?.event).toBe('PreToolUse');
      expect(bash?.command).toBe('echo pre-bash');

      const write = hooks.find((h) => h.matcher === 'Write');
      expect(write?.id).toBe('PreToolUse:1:0');

      const post = hooks.find((h) => h.event === 'PostToolUse');
      expect(post?.id).toBe('PostToolUse:0:0');
      expect(post?.matcher).toBe('Skill');
    });

    it('несколько команд внутри одной matcher-группы получают разные commandIndex', () => {
      writeSettings({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'echo first' },
                { type: 'command', command: 'echo second' },
              ],
            },
          ],
        },
      });

      const hooks = readHooks(settingsPath, store);

      expect(hooks.map((h) => h.id)).toEqual(['PreToolUse:0:0', 'PreToolUse:0:1']);
      expect(hooks.map((h) => h.command)).toEqual(['echo first', 'echo second']);
    });

    it('сохраняет timeout и допускает группу без matcher', () => {
      writeSettings({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi', timeout: 5000 }] }],
        },
      });

      const [hook] = readHooks(settingsPath, store);

      expect(hook?.matcher).toBeUndefined();
      expect(hook?.timeout).toBe(5000);
    });

    it('пустой settings.json даёт пустой список', () => {
      expect(readHooks(settingsPath, store)).toEqual([]);
    });

    it('isEnabled отражает отметку «выключено» в хранилище приложения', () => {
      writeSettings({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
      });
      const id = 'Stop:0:0';

      // По умолчанию хук включён.
      expect(readHooks(settingsPath, store)[0]?.isEnabled).toBe(true);

      // После пометки «выключено» тот же хук читается как отключённый.
      store.setEnabled('hook', id, false);
      expect(readHooks(settingsPath, store)[0]?.isEnabled).toBe(false);
    });

    it('извлекает путь к скрипту и его описание из шапки файла', () => {
      const scriptPath = join(hooksDir, 'guard.mjs');
      writeFileSync(
        scriptPath,
        '// Проверяет команды перед запуском.\n// Вторая строка описания.\n\nprocess.exit(0);\n',
      );
      writeSettings({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: `node "${scriptPath.replace(/\\/g, '/')}"` }],
            },
          ],
        },
      });

      const [hook] = readHooks(settingsPath, store);

      expect(hook?.scriptPath).toBe(scriptPath.replace(/\\/g, '/'));
      expect(hook?.scriptExists).toBe(true);
      expect(hook?.description).toContain('Проверяет команды перед запуском');
    });

    it('помечает несуществующий скрипт как отсутствующий', () => {
      writeSettings({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'node "C:/nope/missing.mjs"' }] }],
        },
      });

      const [hook] = readHooks(settingsPath, store);

      expect(hook?.scriptPath).toBe('C:/nope/missing.mjs');
      expect(hook?.scriptExists).toBe(false);
    });
  });

  describe('writeHooks — сборка плоского списка обратно во вложенную структуру', () => {
    it('объединяет хуки с одинаковым matcher в одну группу', () => {
      const hooks: Hook[] = [
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'echo a' }),
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'echo b' }),
        makeHook({ event: 'PreToolUse', matcher: 'Write', command: 'echo c' }),
      ];

      writeHooks(settingsPath, hooks);
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));

      const groups = saved.hooks.PreToolUse;
      // Bash — одна группа с двумя командами, Write — отдельная группа.
      expect(groups).toHaveLength(2);
      const bashGroup = groups.find((g: { matcher?: string }) => g.matcher === 'Bash');
      expect(bashGroup.hooks).toHaveLength(2);
      expect(bashGroup.hooks.map((c: { command: string }) => c.command)).toEqual([
        'echo a',
        'echo b',
      ]);
      const writeGroup = groups.find((g: { matcher?: string }) => g.matcher === 'Write');
      expect(writeGroup.hooks).toHaveLength(1);
    });

    it('пишет команды в родном формате { type: "command", command } с timeout', () => {
      writeHooks(settingsPath, [
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'echo x', timeout: 3000 }),
      ]);
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));

      expect(saved.hooks.PreToolUse[0].hooks[0]).toEqual({
        type: 'command',
        command: 'echo x',
        timeout: 3000,
      });
    });

    it('группа без matcher не содержит ключа matcher', () => {
      writeHooks(settingsPath, [makeHook({ event: 'Stop', command: 'echo bye' })]);
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));

      expect(saved.hooks.Stop[0]).not.toHaveProperty('matcher');
      expect(saved.hooks.Stop[0].hooks[0].command).toBe('echo bye');
    });

    it('выключенные хуки в settings.json не попадают', () => {
      writeHooks(settingsPath, [
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'enabled', isEnabled: true }),
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'disabled', isEnabled: false }),
      ]);
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));

      const commands = saved.hooks.PreToolUse[0].hooks.map((c: { command: string }) => c.command);
      expect(commands).toEqual(['enabled']);
    });

    it('не затирает посторонние ключи settings.json', () => {
      writeSettings({ env: { NODE_ENV: 'test' }, hooks: {} });

      writeHooks(settingsPath, [makeHook({ event: 'Stop', command: 'echo bye' })]);
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));

      // Секция env должна остаться нетронутой, перезаписывается только hooks.
      expect(saved.env).toEqual({ NODE_ENV: 'test' });
      expect(saved.hooks.Stop).toBeDefined();
    });

    it('чтение после записи возвращает эквивалентный список (round-trip)', () => {
      const original: Hook[] = [
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'echo a' }),
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'echo b' }),
        makeHook({ event: 'PostToolUse', matcher: 'Skill', command: 'echo c' }),
      ];

      writeHooks(settingsPath, original);
      const restored = readHooks(settingsPath, store);

      expect(
        restored.map((h) => ({ event: h.event, matcher: h.matcher, command: h.command })),
      ).toEqual(original.map((h) => ({ event: h.event, matcher: h.matcher, command: h.command })));
    });

    it('создаёт резервную копию, когда указан backupDir', () => {
      const backupDir = join(dir, 'backups');
      const backup = writeHooks(
        settingsPath,
        [makeHook({ event: 'Stop', command: 'echo bye' })],
        backupDir,
      );

      // Исходный settings.json существовал → должна появиться резервная копия.
      expect(backup).toBeTypeOf('string');
      expect(existsSync(backup as string)).toBe(true);
    });
  });

  describe('upsertHook — добавление и правка', () => {
    const baseDraft = (over: Partial<HookDraft>): HookDraft => ({
      event: 'PreToolUse',
      matchers: [],
      isEnabled: true,
      groupIds: [],
      guardPatterns: [],
      command: '',
      ...over,
    });

    it('добавляет новый хук и реально пишет его в settings.json', () => {
      upsertHook(
        settingsPath,
        hooksDir,
        null,
        baseDraft({ matchers: ['Bash', 'Write'], command: 'echo hi' }),
        store,
      );

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const group = saved.hooks.PreToolUse[0];
      // Несколько matcher объединяются в одно регулярное выражение через '|'.
      expect(group.matcher).toBe('Bash|Write');
      expect(group.hooks[0].command).toBe('echo hi');
    });

    it('редактирует существующий хук по id, не плодя новых записей', () => {
      // Готовим один хук в файле и узнаём его id через чтение.
      writeHooks(settingsPath, [makeHook({ event: 'Stop', command: 'old' })]);
      const id = readHooks(settingsPath, store)[0]!.id;

      upsertHook(settingsPath, hooksDir, id, baseDraft({ event: 'Stop', command: 'new' }), store);

      const hooks = readHooks(settingsPath, store);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.command).toBe('new');
    });

    it('по scriptName генерирует файл скрипта и подставляет команду его запуска', () => {
      upsertHook(
        settingsPath,
        hooksDir,
        null,
        baseDraft({
          scriptName: 'guard-check',
          template: 'message',
          message: 'Стоп',
          description: 'Блокирует опасное',
        }),
        store,
      );

      // Файл скрипта реально создан в hooks/.
      const scriptFile = join(hooksDir, 'guard-check.mjs');
      expect(existsSync(scriptFile)).toBe(true);

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.hooks.PreToolUse[0].hooks[0].command).toContain('node "');

      // При обратном чтении путь и описание из шапки восстанавливаются.
      const [hook] = readHooks(settingsPath, store);
      expect(hook?.scriptExists).toBe(true);
      expect(hook?.description).toContain('Блокирует опасное');
    });

    it('выключенный черновик не попадает в settings.json', () => {
      upsertHook(
        settingsPath,
        hooksDir,
        null,
        baseDraft({ command: 'echo off', isEnabled: false }),
        store,
      );

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // hooks пустой: выключенный хук в файл не пишется.
      expect(saved.hooks).toEqual({});
    });
  });

  describe('deleteHook — удаление', () => {
    it('удаляет один хук по id, сохраняя остальные', () => {
      writeHooks(settingsPath, [
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'keep-a' }),
        makeHook({ event: 'PreToolUse', matcher: 'Write', command: 'delete-me' }),
      ]);
      const target = readHooks(settingsPath, store).find((h) => h.command === 'delete-me');

      deleteHook(settingsPath, target!.id, store);

      const remaining = readHooks(settingsPath, store);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.command).toBe('keep-a');
    });

    it('удаление несуществующего id не трогает файл', () => {
      writeHooks(settingsPath, [makeHook({ event: 'Stop', command: 'keep' })]);

      deleteHook(settingsPath, 'Stop:9:9', store);

      const remaining = readHooks(settingsPath, store);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.command).toBe('keep');
    });
  });
});
