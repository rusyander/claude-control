import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderInstructionsEntries,
  readProviderInstructionsInfo,
  parseProviderInstructionsDraft,
  saveProviderInstructionsEntries,
  readListedInstructionsFile,
  writeListedInstructionsFile,
  resolveEntryPath,
  ListedFileNotEditableError,
  type ProviderInstructionsTarget,
} from './provider-instructions.ts';

/**
 * AIDER-1: инструкции как СПИСОК ССЫЛОК (`read` в `.aider.conf.yml`).
 *
 * Проверяем обещанное: список читается в обеих задокументированных формах;
 * добавление/удаление/перестановка сохраняют комментарии и прочие ключи;
 * отсутствующий файл ЧЕСТНО помечен и НЕ создаётся молча; содержимое
 * перечисленного файла правится с бэкапом и сохранением формы; запись «мимо
 * списка» отклоняется; битый YAML переводит раздел в режим чтения.
 *
 * Каталоги — временные, настоящий `~` не задействован ни на чтение, ни на запись.
 */
const CONFIG = `## Модель для основного чата
model: gpt-4o

## Файлы-конвенции
read:
  - CONVENTIONS.md
  - docs/style.md

## Set an environment variable
set-env:
  - OPENAI_API_TYPE=azure
`;

describe('Aider инструкции-список: чтение и запись `read`', () => {
  let root: string;
  let backupDir: string;
  let configPath: string;

  const target = (): ProviderInstructionsTarget => ({
    provider: getProvider('aider'),
    format: 'aider-yaml',
    scope: 'global',
    configPath,
    baseDir: root,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-aider-read-'));
    backupDir = join(root, 'backups');
    configPath = join(root, '.aider.conf.yml');
    writeFileSync(configPath, CONFIG, 'utf8');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('записи получают абсолютный путь и честный флаг существования', () => {
    writeFileSync(join(root, 'CONVENTIONS.md'), '# правила\n', 'utf8');
    const entries = readProviderInstructionsEntries(target());

    expect(entries.map((e) => e.raw)).toEqual(['CONVENTIONS.md', 'docs/style.md']);
    expect(entries[0]).toMatchObject({
      path: join(root, 'CONVENTIONS.md'),
      exists: true,
      editable: true,
    });
    // Файла нет — так и сказано, и панель его НЕ создала.
    expect(entries[1]).toMatchObject({ exists: false, editable: false, reason: 'missing' });
    expect(existsSync(join(root, 'docs', 'style.md'))).toBe(false);
  });

  it('абсолютная запись остаётся абсолютной, относительная — от каталога конфига', () => {
    const abs = join(root, 'elsewhere.md');
    expect(resolveEntryPath(target(), abs)).toBe(abs);
    expect(resolveEntryPath(target(), 'a/b.md')).toBe(join(root, 'a', 'b.md'));
  });

  it('добавление/удаление/перестановка сохраняют комментарии и прочие ключи', () => {
    saveProviderInstructionsEntries(target(), ['docs/style.md', 'CONVENTIONS.md'], backupDir);
    const after = readFileSync(configPath, 'utf8');

    expect(readProviderInstructionsEntries(target()).map((e) => e.raw)).toEqual([
      'docs/style.md',
      'CONVENTIONS.md',
    ]);
    expect(after).toContain('## Модель для основного чата');
    expect(after).toContain('## Файлы-конвенции');
    expect(after).toContain('model: gpt-4o');
    expect(after).toContain('OPENAI_API_TYPE=azure');
  });

  it('пустой список убирает ключ `read`, не трогая остальное', () => {
    saveProviderInstructionsEntries(target(), [], backupDir);
    const after = readFileSync(configPath, 'utf8');
    expect(after).not.toContain('read:');
    expect(after).toContain('set-env:');
  });

  it('перед записью делается копия под именем провайдера, временных хвостов нет', () => {
    saveProviderInstructionsEntries(target(), ['CONVENTIONS.md'], backupDir);
    const backups = existsSync(backupDir) ? readdirSync(backupDir) : [];
    expect(backups.some((name) => name.startsWith('aider-.aider.conf.yml'))).toBe(true);
    expect(readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('BOM и CRLF конфига переживают запись', () => {
    writeFileSync(configPath, `\uFEFF${CONFIG.replace(/\n/g, '\r\n')}`, 'utf8');
    saveProviderInstructionsEntries(target(), ['CONVENTIONS.md'], backupDir);
    const raw = readFileSync(configPath, 'utf8');
    expect(raw.startsWith('\uFEFF')).toBe(true);
    expect(raw.includes('\r\n')).toBe(true);
  });

  it('битый YAML → раздел только для чтения, файл не тронут', () => {
    writeFileSync(configPath, 'read: [a\n  - b\n', 'utf8');
    const info = readProviderInstructionsInfo(target());
    expect(info.readOnly).toBe(true);
    expect(info.entries).toEqual([]);
    expect(() => saveProviderInstructionsEntries(target(), ['x.md'], backupDir)).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe('read: [a\n  - b\n');
  });

  it('черновик: пустые записи и не-строки отвергаются, дубликаты схлопываются', () => {
    expect(parseProviderInstructionsDraft({ entries: ['a.md', 'a.md', 'b.md'] })).toEqual([
      'a.md',
      'b.md',
    ]);
    expect(parseProviderInstructionsDraft({ entries: [''] })).toBeUndefined();
    expect(parseProviderInstructionsDraft({ entries: ['a\nb'] })).toBeUndefined();
    expect(parseProviderInstructionsDraft({ entries: [1] })).toBeUndefined();
    expect(parseProviderInstructionsDraft({})).toBeUndefined();
  });
});

describe('Aider инструкции-список: содержимое перечисленного файла', () => {
  let root: string;
  let backupDir: string;
  let configPath: string;

  const target = (): ProviderInstructionsTarget => ({
    provider: getProvider('aider'),
    format: 'aider-yaml',
    scope: 'global',
    configPath,
    baseDir: root,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-aider-file-'));
    backupDir = join(root, 'backups');
    configPath = join(root, '.aider.conf.yml');
    writeFileSync(configPath, CONFIG, 'utf8');
    writeFileSync(join(root, 'CONVENTIONS.md'), 'Пиши тесты.\n', 'utf8');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('round-trip: читаем, правим, читаем — содержимое совпадает', () => {
    expect(readListedInstructionsFile(target(), 'CONVENTIONS.md').content).toBe('Пиши тесты.\n');
    writeListedInstructionsFile(target(), 'CONVENTIONS.md', 'Новые правила.\n', backupDir);
    expect(readListedInstructionsFile(target(), 'CONVENTIONS.md').content).toBe('Новые правила.\n');
  });

  it('файла из списка нет — отказ с причиной missing, файл НЕ создаётся', () => {
    expect(() => readListedInstructionsFile(target(), 'docs/style.md')).toThrow(
      ListedFileNotEditableError,
    );
    expect(() =>
      writeListedInstructionsFile(target(), 'docs/style.md', 'что-то', backupDir),
    ).toThrow(ListedFileNotEditableError);
    expect(existsSync(join(root, 'docs', 'style.md'))).toBe(false);
  });

  it('файл вне списка не открывается и не пишется (unlisted)', () => {
    writeFileSync(join(root, 'secret.md'), 'секрет\n', 'utf8');
    try {
      readListedInstructionsFile(target(), 'secret.md');
      expect.unreachable('должно было отказать');
    } catch (error) {
      expect((error as ListedFileNotEditableError).reason).toBe('unlisted');
    }
    expect(readFileSync(join(root, 'secret.md'), 'utf8')).toBe('секрет\n');
  });

  it('бинарный файл из списка помечен и не открывается', () => {
    writeFileSync(join(root, 'CONVENTIONS.md'), Buffer.from([0x50, 0x00, 0x51]));
    const entry = readProviderInstructionsEntries(target())[0]!;
    expect(entry).toMatchObject({ exists: true, editable: false, reason: 'binary' });
    expect(() => readListedInstructionsFile(target(), 'CONVENTIONS.md')).toThrow(
      ListedFileNotEditableError,
    );
  });

  it('проектный уровень: файл за пределами проекта не открывается (unsafe_path)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-aider-outside-'));
    const projectRoot = join(root, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const projectConfig = join(projectRoot, '.aider.conf.yml');
    const escapeRelative = join('..', '..', 'escape.md');
    writeFileSync(join(root, 'escape.md'), 'наружу\n', 'utf8');
    writeFileSync(
      projectConfig,
      `read:\n  - ${escapeRelative.split('\\').join('/')}\n  - ${outside.split('\\').join('/')}/x.md\n`,
      'utf8',
    );

    const projectTarget: ProviderInstructionsTarget = {
      provider: getProvider('aider'),
      format: 'aider-yaml',
      scope: 'project',
      configPath: projectConfig,
      baseDir: projectRoot,
      projectRoot,
    };

    // Обе записи вне проекта: раздел их показывает, но открыть не даёт.
    for (const entry of readProviderInstructionsEntries(projectTarget)) {
      expect(entry.editable).toBe(false);
    }
    for (const raw of readProviderInstructionsEntries(projectTarget).map((e) => e.raw)) {
      expect(() => readListedInstructionsFile(projectTarget, raw)).toThrow(
        ListedFileNotEditableError,
      );
    }
    expect(readFileSync(join(root, 'escape.md'), 'utf8')).toBe('наружу\n');
    rmSync(outside, { recursive: true, force: true });
  });
});
