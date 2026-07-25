import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { BOM_CHAR } from '../lib/text-form.ts';
import { UnrecognizedFormatError } from '../lib/codex-toml.ts';
import {
  readProviderPluginsInfo,
  readProviderPluginFile,
  saveProviderPluginFile,
  deleteProviderPluginFile,
  parseProviderPluginFileDraft,
  parseProviderPluginPackagesDraft,
  saveProviderPluginPackages,
  resolvePluginPath,
  UnsafePluginPathError,
  PluginFileNotFoundError,
  type ProviderPluginsTarget,
} from './provider-plugins.ts';

/**
 * OPENCODE-4: плагины OpenCode — каталог файлов JS/TS плюс массив `plugin` в
 * `opencode.json`.
 *
 * Проверяем главное: список файлов (включая вложенные), round-trip создания /
 * правки / удаления, ЗАЩИТУ ПУТЕЙ (та же, что у правил Cursor) одинаково на
 * чтении, записи и удалении, чтение и правку npm-списка с сохранением всех
 * прочих ключей конфига, fail-closed на битом JSON.
 *
 * Файлы — только во временных каталогах, домашний каталог не затрагивается.
 */
describe('OpenCode: плагины (каталог файлов + массив plugin)', () => {
  let root: string;
  let backupDir: string;
  let target: ProviderPluginsTarget;
  // Путь конфига у цели необязателен (у Kimi его нет вовсе), а тестам OpenCode
  // он нужен строкой — держим его отдельно, чтобы не сыпать `!` по всему файлу.
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-opencode-plugins-'));
    backupDir = join(root, 'backups');
    configPath = join(root, 'opencode.json');
    target = {
      provider: getProvider('opencode'),
      format: 'opencode-plugins',
      scope: 'global',
      pluginsDir: join(root, 'plugins'),
      configPath,
      backupPrefix: 'opencode-',
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const save = (path: string, content: string) =>
    saveProviderPluginFile(target, { path, content }, backupDir);

  // --- Файлы каталога ---------------------------------------------------------

  it('каталога нет — список пуст, каталог НЕ создаётся', () => {
    const info = readProviderPluginsInfo(target);
    expect(info.dirExists).toBe(false);
    expect(info.files).toEqual([]);
    expect(info.filesReadOnly).toBe(false);
    expect(existsSync(target.pluginsDir)).toBe(false);
  });

  it('перечисляет .js/.ts/.mjs включая вложенные; чужие расширения отдельно', () => {
    mkdirSync(join(target.pluginsDir, 'git'), { recursive: true });
    writeFileSync(join(target.pluginsDir, 'notify.ts'), 'export const a = 1;\n');
    writeFileSync(join(target.pluginsDir, 'legacy.js'), '');
    writeFileSync(join(target.pluginsDir, 'esm.mjs'), '');
    writeFileSync(join(target.pluginsDir, 'README.md'), '# нет');
    writeFileSync(join(target.pluginsDir, 'git', 'hook.ts'), '');

    const info = readProviderPluginsInfo(target);
    expect(info.dirExists).toBe(true);
    expect(info.files.map((file) => file.path)).toEqual([
      'esm.mjs',
      'git/hook.ts',
      'legacy.js',
      'notify.ts',
    ]);
    expect(info.ignored.map((file) => file.path)).toEqual(['README.md']);
    // Размер отдаётся честно, путь — абсолютный.
    const notify = info.files.find((file) => file.path === 'notify.ts')!;
    expect(notify.size).toBeGreaterThan(0);
    expect(notify.fullPath).toBe(join(target.pluginsDir, 'notify.ts'));
  });

  it('round-trip файла: создание, чтение, правка, удаление с копией', () => {
    const created = save('git/hook.ts', 'export const plugin = () => {};\n');
    expect(created.path).toBe('git/hook.ts');
    expect(existsSync(created.fullPath)).toBe(true);

    expect(readProviderPluginFile(target, 'git/hook.ts').content).toBe(
      'export const plugin = () => {};\n',
    );

    const updated = save('git/hook.ts', 'export const plugin = () => 1;\n');
    // Существующий файл перед перезаписью копируется.
    expect(updated.backupPath).toBeTruthy();
    expect(readFileSync(created.fullPath, 'utf8')).toBe('export const plugin = () => 1;\n');

    const removed = deleteProviderPluginFile(target, 'git/hook.ts', backupDir);
    expect(removed.backupPath).toBeTruthy();
    expect(existsSync(created.fullPath)).toBe(false);
    // Опустевший подкаталог остаётся: чужие каталоги панель не убирает.
    expect(existsSync(join(target.pluginsDir, 'git'))).toBe(true);
  });

  it('BOM и CRLF файла плагина сохраняются', () => {
    mkdirSync(target.pluginsDir, { recursive: true });
    const filePath = join(target.pluginsDir, 'form.ts');
    writeFileSync(filePath, `${BOM_CHAR}const a = 1;\r\nconst b = 2;\r\n`);

    save('form.ts', 'const a = 1;\nconst c = 3;\n');

    const raw = readFileSync(filePath, 'utf8');
    expect(raw.startsWith(BOM_CHAR)).toBe(true);
    expect(raw).toContain('\r\n');
  });

  it('файла нет → not_found, а не «пустое содержимое»', () => {
    expect(() => readProviderPluginFile(target, 'missing.ts')).toThrow(PluginFileNotFoundError);
    expect(() => deleteProviderPluginFile(target, 'missing.ts', backupDir)).toThrow(
      PluginFileNotFoundError,
    );
  });

  it('не текстовый файл под известным расширением не открывается (422)', () => {
    mkdirSync(target.pluginsDir, { recursive: true });
    writeFileSync(join(target.pluginsDir, 'binary.js'), Buffer.from([0x41, 0x00, 0x42]));
    expect(() => readProviderPluginFile(target, 'binary.js')).toThrow(/не является текстовым/);
  });

  // --- Защита путей -----------------------------------------------------------

  it('отклоняет «..», абсолютные, UNC, NUL, пустые сегменты и чужие расширения', () => {
    const bad = [
      '',
      '   ',
      '..',
      '../outside.ts',
      'git/../../outside.ts',
      './notify.ts',
      'sub//notify.ts',
      'C:\\Windows\\evil.ts',
      '/etc/evil.ts',
      '\\\\server\\share\\evil.ts',
      'notify.ts\u0000.txt',
      // Расширение вне белого списка.
      'notify.md',
      'notify.json',
      'notify',
      // Пустое имя при верном расширении.
      '.ts',
    ];

    for (const path of bad) {
      expect(() => resolvePluginPath(target, path), path).toThrow(UnsafePluginPathError);
      // ЗАПИСЬ и УДАЛЕНИЕ отклоняются ТАК ЖЕ — 400, а не 404.
      expect(() => save(path, 'x'), path).toThrow(UnsafePluginPathError);
      expect(() => deleteProviderPluginFile(target, path, backupDir), path).toThrow(
        UnsafePluginPathError,
      );
      expect(() => readProviderPluginFile(target, path), path).toThrow(UnsafePluginPathError);
    }

    // Ничего наружу каталога не создано.
    expect(existsSync(join(root, 'outside.ts'))).toBe(false);
  });

  it('символическая ссылка в сегменте пути отклоняется (или пропускается на Windows)', () => {
    mkdirSync(target.pluginsDir, { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'evil.ts'), 'evil');

    try {
      symlinkSync(outside, join(target.pluginsDir, 'link'), 'dir');
    } catch {
      // Без прав на создание ссылок (обычный Windows) сценарий непроверяем —
      // честно пропускаем, а не изображаем зелёный тест.
      return;
    }

    for (const op of [
      () => resolvePluginPath(target, 'link/evil.ts'),
      () => save('link/evil.ts', 'x'),
      () => deleteProviderPluginFile(target, 'link/evil.ts', backupDir),
      () => readProviderPluginFile(target, 'link/evil.ts'),
    ]) {
      expect(op).toThrow(UnsafePluginPathError);
    }
    // Файл за ссылкой не тронут.
    expect(readFileSync(join(outside, 'evil.ts'), 'utf8')).toBe('evil');
    // Обход каталога по ссылке не идёт — «чужого» файла в списке нет.
    expect(readProviderPluginsInfo(target).files).toEqual([]);
  });

  it('черновик файла: путь и содержимое обязательны, NUL запрещён', () => {
    expect(parseProviderPluginFileDraft(null)).toBeUndefined();
    expect(parseProviderPluginFileDraft({ path: 'a.ts' })).toBeUndefined();
    expect(parseProviderPluginFileDraft({ path: '  ', content: 'x' })).toBeUndefined();
    expect(parseProviderPluginFileDraft({ path: 'a.ts', content: 42 })).toBeUndefined();
    expect(parseProviderPluginFileDraft({ path: 'a.ts', content: 'x\u0000y' })).toBeUndefined();
    // Пустое содержимое — осознанная заготовка файла.
    expect(parseProviderPluginFileDraft({ path: 'a.ts', content: '' })).toEqual({
      path: 'a.ts',
      content: '',
    });
  });

  // --- npm-список (`plugin` в opencode.json) ----------------------------------

  const CONFIG = JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4',
      permission: { edit: 'deny' },
      plugin: [
        'opencode-wakatime',
        '@my-org/custom-plugin',
        // Расширенная форма «имя + настройки»: панель её не ведёт.
        ['opencode-helicone-session', { apiKey: 'x' }],
      ],
    },
    null,
    2,
  );

  it('читает npm-список; расширенная форма уходит в «сохранённые»', () => {
    writeFileSync(configPath, CONFIG);

    const info = readProviderPluginsInfo(target);
    expect(info.packagesPresent).toBe(true);
    expect(info.packages).toEqual(['opencode-wakatime', '@my-org/custom-plugin']);
    expect(info.preservedPackages).toEqual([
      { index: 2, value: expect.stringContaining('helicone') },
    ]);
    expect(info.packagesReadOnly).toBe(false);
  });

  it('пишет npm-список, сохраняя прочие ключи файла и расширенные записи', () => {
    writeFileSync(configPath, CONFIG);

    const backupPath = saveProviderPluginPackages(
      target,
      ['opencode-wakatime', 'opencode-notify'],
      backupDir,
    );
    expect(backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(written.$schema).toBe('https://opencode.ai/config.json');
    expect(written.model).toBe('anthropic/claude-sonnet-4');
    expect(written.permission).toEqual({ edit: 'deny' });
    // Расширенная запись цела; убранный пакет исчез, добавленный появился.
    expect(written.plugin).toEqual([
      ['opencode-helicone-session', { apiKey: 'x' }],
      'opencode-wakatime',
      'opencode-notify',
    ]);
  });

  it('пустой список УДАЛЯЕТ ключ plugin, а не пишет []', () => {
    writeFileSync(configPath, JSON.stringify({ model: 'x', plugin: ['a'] }));
    saveProviderPluginPackages(target, [], backupDir);

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(written.model).toBe('x');
    expect('plugin' in written).toBe(false);
  });

  it('пустой список при сохранённых записях ключ НЕ удаляет', () => {
    writeFileSync(configPath, JSON.stringify({ plugin: [['a', {}], 'b'] }));
    saveProviderPluginPackages(target, [], backupDir);
    expect(
      (JSON.parse(readFileSync(configPath, 'utf8')) as { plugin: unknown }).plugin,
    ).toEqual([['a', {}]]);
  });

  it('битый JSON и не-массив plugin: список только для чтения, файл не тронут', () => {
    const before = '{ "plugin": ';
    writeFileSync(configPath, before);

    const info = readProviderPluginsInfo(target);
    expect(info.packagesReadOnly).toBe(true);
    expect(info.packagesError).toBeTruthy();
    // Файловая половина при этом работает — они независимы.
    expect(info.filesReadOnly).toBe(false);

    expect(() => saveProviderPluginPackages(target, ['a'], backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(existsSync(backupDir)).toBe(false);

    writeFileSync(configPath, JSON.stringify({ plugin: { a: 1 } }));
    expect(readProviderPluginsInfo(target).packagesReadOnly).toBe(true);
  });

  it('черновик списка: только непустые строки без пробелов и кавычек, без повторов', () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { packages: 'a' },
      { packages: [42] },
      { packages: [''] },
      { packages: ['  '] },
      { packages: ['with space'] },
      { packages: ['with"quote'] },
      { packages: [' leading'] },
      { packages: ['a', 'a'] },
    ];
    for (const body of bad) {
      expect(parseProviderPluginPackagesDraft(body), JSON.stringify(body)).toBeUndefined();
    }

    expect(parseProviderPluginPackagesDraft({ packages: ['opencode-wakatime', '@org/p'] })).toEqual(
      ['opencode-wakatime', '@org/p'],
    );
    // Пустой список допустим — он удаляет ключ.
    expect(parseProviderPluginPackagesDraft({ packages: [] })).toEqual([]);
  });

  it('конфига нет — список пуст, файл НЕ создаётся при чтении', () => {
    const info = readProviderPluginsInfo(target);
    expect(info.packagesPresent).toBe(false);
    expect(info.packages).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });
});
