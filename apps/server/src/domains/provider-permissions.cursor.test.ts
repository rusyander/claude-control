import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  buildProviderPermissionInfo,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';

/**
 * Права Cursor (CURSOR-2) — ключ `permissions` файла `~/.cursor/cli-config.json`
 * (в проекте — `<проект>/.cursor/cli.json`, имя ДРУГОЕ) с двумя списками
 * `allow`/`deny`. Ни режима, ни списка `ask` у этой модели нет. Проверяем:
 * чтение обоих списков, «на дефолтах» только пока ключа `permissions` нет,
 * пустой список удаляет свой ключ, пустые оба — весь объект, соседние ключи
 * файла (`version`, `editor`) целы, чужая форма не перезаписывается.
 */
describe('Cursor cli-config.json: два списка allow/deny без режима', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('cursor'),
    format: 'cursor-json',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до cursor-модели. */
  const readCursor = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'cursor') throw new Error('ожидалась cursor-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const CONFIG = JSON.stringify(
    {
      version: 1,
      editor: { vimMode: false },
      permissions: {
        allow: ['Shell(git status)', 'Read(src/**)'],
        deny: ['Shell(rm -rf*)'],
      },
    },
    null,
    2,
  );

  it('чтение отдаёт оба списка', () => {
    const filePath = join(root, 'cli-config.json');
    writeFileSync(filePath, CONFIG, 'utf8');
    expect(readCursor(filePath)).toEqual({
      kind: 'cursor',
      allow: ['Shell(git status)', 'Read(src/**)'],
      deny: ['Shell(rm -rf*)'],
      usingDefaults: false,
    });
  });

  it('нет файла → дефолты CLI, и они НЕ записаны', () => {
    const filePath = join(root, 'absent.json');
    expect(readCursor(filePath)).toEqual({
      kind: 'cursor',
      allow: [],
      deny: [],
      usingDefaults: true,
    });
    expect(existsSync(filePath)).toBe(false);
  });

  it('файл без ключа permissions — «на дефолтах»; пустой allow: [] — уже настройка', () => {
    const onlyOther = join(root, 'other.json');
    writeFileSync(onlyOther, JSON.stringify({ version: 1 }), 'utf8');
    expect(readCursor(onlyOther).usingDefaults).toBe(true);

    const emptyList = join(root, 'empty-list.json');
    writeFileSync(emptyList, JSON.stringify({ permissions: { allow: [] } }), 'utf8');
    expect(readCursor(emptyList)).toMatchObject({ allow: [], usingDefaults: false });
  });

  it('запись меняет только ключ permissions: version и editor целы', () => {
    const filePath = join(root, 'cli-config.json');
    writeFileSync(filePath, CONFIG, 'utf8');

    saveProviderPermissions(
      targetFor(filePath),
      { allow: ['Read(src/**)'], deny: ['Shell(rm -rf*)', 'Write(.env)'] },
      backupDir,
    );

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      editor: { vimMode: false },
      permissions: {
        allow: ['Read(src/**)'],
        deny: ['Shell(rm -rf*)', 'Write(.env)'],
      },
    });
  });

  it('соседние ключи ВНУТРИ permissions сохраняются', () => {
    const filePath = join(root, 'cli-config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ permissions: { allow: ['Read(**)'], somethingNew: { a: 1 } } }),
      'utf8',
    );

    saveProviderPermissions(targetFor(filePath), { allow: [], deny: ['Write(**)'] }, backupDir);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      permissions: { somethingNew: { a: 1 }, deny: ['Write(**)'] },
    });
  });

  it('пустой список удаляет свой ключ, пустые оба — весь permissions', () => {
    const filePath = join(root, 'cli-config.json');
    writeFileSync(filePath, CONFIG, 'utf8');

    saveProviderPermissions(targetFor(filePath), { allow: ['Read(**)'], deny: [] }, backupDir);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).permissions).toEqual({
      allow: ['Read(**)'],
    });

    saveProviderPermissions(targetFor(filePath), { allow: [], deny: [] }, backupDir);
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(config.permissions).toBeUndefined();
    expect(config.version).toBe(1);
  });

  it('нет файла → создаётся только с непустыми списками, version панель не выдумывает', () => {
    const filePath = join(root, 'fresh.json');
    saveProviderPermissions(targetFor(filePath), { allow: [], deny: ['Shell(curl *)'] }, backupDir);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      permissions: { deny: ['Shell(curl *)'] },
    });
  });

  it('round-trip: чтение → запись → чтение стабильно', () => {
    const filePath = join(root, 'cli-config.json');
    writeFileSync(filePath, CONFIG, 'utf8');

    const before = readCursor(filePath);
    saveProviderPermissions(
      targetFor(filePath),
      { allow: before.allow, deny: before.deny },
      backupDir,
    );
    expect(readCursor(filePath)).toEqual(before);
  });

  it('черновик: режима нет вовсе, повторы схлопываются, не-строки отклоняются', () => {
    expect(
      parseProviderPermissionsDraft({ allow: [' Shell(ls) ', 'Shell(ls)', ''] }, 'cursor-json'),
    ).toEqual({ allow: ['Shell(ls)'], deny: [] });
    // Лишний ключ режима просто игнорируется: у Cursor его нет.
    expect(parseProviderPermissionsDraft({ approvalMode: 'yolo' }, 'cursor-json')).toEqual({
      allow: [],
      deny: [],
    });
    expect(parseProviderPermissionsDraft({ allow: 'Shell(ls)' }, 'cursor-json')).toBeUndefined();
    expect(parseProviderPermissionsDraft({ deny: [42] }, 'cursor-json')).toBeUndefined();
  });

  it('битый JSON: чтение и запись fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'broken.json');
    const broken = '{ "permissions": { "allow": [ }\n';
    writeFileSync(filePath, broken, 'utf8');

    expect(() => readCursor(filePath)).toThrow(UnrecognizedFormatError);
    expect(() =>
      saveProviderPermissions(targetFor(filePath), { allow: ['Read(**)'], deny: [] }, backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма (permissions строкой, список из чисел, корень-массив) — fail-closed', () => {
    const asString = join(root, 'string.json');
    writeFileSync(asString, JSON.stringify({ permissions: 'all' }), 'utf8');
    expect(() => readCursor(asString)).toThrow(UnrecognizedFormatError);

    const numbers = join(root, 'numbers.json');
    writeFileSync(numbers, JSON.stringify({ permissions: { allow: [1, 2] } }), 'utf8');
    expect(() => readCursor(numbers)).toThrow(UnrecognizedFormatError);

    const arrayRoot = join(root, 'array.json');
    writeFileSync(arrayRoot, JSON.stringify([{ permissions: {} }]), 'utf8');
    expect(() => readCursor(arrayRoot)).toThrow(UnrecognizedFormatError);
  });

  it('сводка раздела: kind cursor, формы правил из документации, битый файл → только чтение', () => {
    const filePath = join(root, 'cli-config.json');
    writeFileSync(filePath, CONFIG, 'utf8');
    const info = buildProviderPermissionInfo(targetFor(filePath));
    expect(info).toMatchObject({
      kind: 'cursor',
      format: 'cursor-json',
      allow: ['Shell(git status)', 'Read(src/**)'],
      deny: ['Shell(rm -rf*)'],
      ruleKinds: ['Shell', 'Read', 'Write', 'WebFetch', 'Mcp'],
      readOnly: false,
    });

    const broken = join(root, 'broken2.json');
    writeFileSync(broken, '{ oops', 'utf8');
    expect(buildProviderPermissionInfo(targetFor(broken))).toMatchObject({
      kind: 'cursor',
      readOnly: true,
      allow: [],
      deny: [],
    });
  });

  it('каталог: у cursor права ready, глобальный файл cli-config.json, проектный cli.json', () => {
    const provider = getProvider('cursor');
    expect(provider.capabilities.permissions).toBe('ready');
    expect(provider.permissionsConfig).toMatchObject({ format: 'cursor-json' });
    expect(provider.permissionsConfig?.path()).toMatch(/[\\/]\.cursor[\\/]cli-config\.json$/);
    expect(provider.projectConfig?.permissions).toEqual({
      format: 'cursor-json',
      relativePath: '.cursor/cli.json',
    });
  });
});
