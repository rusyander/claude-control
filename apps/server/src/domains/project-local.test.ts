import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { readProjectLocalConfig, readRuleFiles } from './project-local.ts';

/**
 * Проектный `.claude` читается как есть: скиллы обоих каталогов, хуки обоих
 * файлов настроек со своим `source`, правила рекурсивно с масками из шапки.
 * Ничего из состояния панели (группы, отметки «выключено», снимки хуков)
 * в ответ не попадает — это пользовательский уровень, а не проектный.
 */
describe('project-local: чтение .claude проекта', () => {
  let dir: string;
  let projectDir: string;
  let store: AppStore;

  const claude = (...parts: string[]): string => join(projectDir, '.claude', ...parts);

  const write = (path: string, content: string): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-project-local-'));
    projectDir = join(dir, 'repo');
    mkdirSync(projectDir, { recursive: true });
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('без каталога .claude — exists:false и пустые списки', () => {
    const config = readProjectLocalConfig(projectDir, store);
    expect(config.exists).toBe(false);
    expect(config.root).toBe(claude());
    expect(config.skills).toEqual([]);
    expect(config.hooks).toEqual([]);
    expect(config.rules).toEqual([]);
  });

  it('пустой .claude — exists:true, списки пусты', () => {
    mkdirSync(claude(), { recursive: true });
    const config = readProjectLocalConfig(projectDir, store);
    expect(config.exists).toBe(true);
    expect(config.skills).toEqual([]);
    expect(config.hooks).toEqual([]);
    expect(config.rules).toEqual([]);
  });

  it('скиллы: включённый из skills/, выключенный из skills-disabled/, групп нет', () => {
    write(
      claude('skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Выкатка\n---\nТело.\n',
    );
    write(
      claude('skills-disabled', 'legacy', 'SKILL.md'),
      '---\nname: legacy\ndescription: Старое\n---\n',
    );
    // Членство в группе на пользовательском уровне с тем же id протечь не должно.
    store.saveGroup({
      id: 'g1',
      name: 'Группа',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'deploy' }],
      env: {},
      isEnabled: true,
      order: 0,
    });

    const { skills } = readProjectLocalConfig(projectDir, store);
    expect(skills.map((skill) => [skill.id, skill.isEnabled])).toEqual([
      ['deploy', true],
      ['legacy', false],
    ]);
    expect(skills.every((skill) => skill.groupIds.length === 0)).toBe(true);
    expect(skills[0]?.description).toBe('Выкатка');
  });

  it('хуки: settings.json и settings.local.json со своим source, без оверлея панели', () => {
    write(
      claude('settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        },
      }),
    );
    write(
      claude('settings.local.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop', timeout: 5 }] }] },
      }),
    );

    const { hooks } = readProjectLocalConfig(projectDir, store);
    expect(hooks).toHaveLength(2);

    const pre = hooks.find((hook) => hook.command === 'echo pre');
    expect(pre?.source).toBe('settings');
    expect(pre?.event).toBe('PreToolUse');
    expect(pre?.matcher).toBe('Bash');
    expect(pre?.isEnabled).toBe(true);
    expect(pre?.groupIds).toEqual([]);

    const stop = hooks.find((hook) => hook.command === 'echo stop');
    expect(stop?.source).toBe('settings-local');
    expect(stop?.id.startsWith('local:')).toBe(true);
    expect(stop?.timeout).toBe(5);
    expect(stop?.isEnabled).toBe(true);
  });

  it('хуки: отметка «выключено» и снимок из состояния панели в проектный список не попадают', () => {
    write(
      claude('settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
      }),
    );
    const [hook] = readProjectLocalConfig(projectDir, store).hooks;
    expect(hook).toBeTruthy();

    // Пользователь выключил хук с таким же содержимым у себя в ~/.claude,
    // а панель помнит снимок другого хука — ни то, ни другое не проектное.
    store.setEnabled('hook', hook!.id, false, hook!.legacyId);
    store.rememberDisabledHook({
      id: 'x',
      event: 'Stop',
      command: 'echo remembered',
      isEnabled: false,
      groupIds: [],
      source: 'settings',
    });

    const { hooks } = readProjectLocalConfig(projectDir, store);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.isEnabled).toBe(true);
    expect(hooks.some((item) => item.command === 'echo remembered')).toBe(false);
  });

  it('правила: рекурсивно, отсортированы по posix-пути, шапка снята, paths в обеих формах', () => {
    write(
      claude('rules', 'style.md'),
      '---\npaths: "src/**/*.tsx"\n---\n# Стиль\n\nТекст правила.\n',
    );
    write(
      claude('rules', 'backend', 'db.md'),
      '---\npaths:\n  - "apps/server/**"\n  - "migrations/**"\n---\n# База данных\n\nТолько чтение.\n',
    );
    write(claude('rules', 'backend', 'api.md'), 'Правило без шапки и без заголовка.\n');
    write(claude('rules', '.hidden', 'secret.md'), '# Скрыто\n');
    write(claude('rules', 'notes.txt'), 'не markdown');

    const { rules } = readProjectLocalConfig(projectDir, store);
    expect(rules.map((rule) => rule.path)).toEqual(['backend/api.md', 'backend/db.md', 'style.md']);

    const [api, db, style] = rules;
    expect(api?.title).toBe('api');
    expect(api?.paths).toEqual([]);
    expect(api?.body).toBe('Правило без шапки и без заголовка.\n');

    expect(db?.title).toBe('База данных');
    expect(db?.paths).toEqual(['apps/server/**', 'migrations/**']);
    expect(db?.body.startsWith('# База данных')).toBe(true);

    expect(style?.title).toBe('Стиль');
    expect(style?.paths).toEqual(['src/**/*.tsx']);
    expect(style?.body).not.toContain('paths:');
    expect(style?.sizeBytes).toBeGreaterThan(0);
    expect(() => new Date(style!.modifiedAt).toISOString()).not.toThrow();
  });

  it('правила: paths не строка и не список → пусто; каталога rules нет → пусто', () => {
    write(claude('rules', 'odd.md'), '---\npaths: 42\n---\n# Странное\n');
    expect(readRuleFiles(claude('rules'))[0]?.paths).toEqual([]);
    expect(readRuleFiles(claude('nope'))).toEqual([]);
  });

  it('правила: нечитаемая запись пропускается, остальные читаются', () => {
    write(claude('rules', 'ok.md'), '# Ок\n');
    // Каталог с расширением .md — не файл; в список правил он попасть не должен.
    mkdirSync(claude('rules', 'broken.md'), { recursive: true });

    const rules = readRuleFiles(claude('rules'));
    expect(rules.map((rule) => rule.path)).toEqual(['ok.md']);
  });
});
