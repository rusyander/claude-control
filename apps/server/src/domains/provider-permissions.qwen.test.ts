import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';

/**
 * Права Qwen Code в `settings.json`: `tools.approvalMode` плюс три списка правил
 * `permissions.allow` / `ask` / `deny`. Проверяем главное: правятся ТОЛЬКО эти
 * ключи (соседи внутри `tools`, устаревшие `tools.core`/`allowed`/`exclude` и
 * весь `mcpServers` целы), `yolo` РАЗРЕШЁН (в отличие от Gemini — у Qwen это
 * задокументированное значение файла), пустой список удаляет ключ, пустые все
 * три — весь объект `permissions`, битый JSON не перезаписывается. Файлы —
 * только во временных каталогах.
 */
describe('Qwen settings.json права: точечная правка ключей прав', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('qwen'),
    format: 'qwen-json',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до qwen-модели (у цели формат `qwen-json`). */
  const readQwen = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'qwen') throw new Error('ожидалась qwen-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-qwen-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Живой settings.json: тема, MCP-серверы, соседний ключ внутри tools и
  // устаревший tools.core — панель его не ведёт, но обязана сохранить.
  const SETTINGS = JSON.stringify(
    {
      ui: { theme: 'Dark' },
      tools: { approvalMode: 'auto-edit', core: ['ReadFile'], sandbox: false },
      permissions: { deny: ['Bash(rm -rf *)'] },
      mcpServers: { probe: { command: 'node', args: ['x.js'] } },
    },
    null,
    2,
  );

  it('чтение отдаёт режим и все три списка', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');
    expect(readQwen(filePath)).toEqual({
      kind: 'qwen',
      approvalMode: 'auto-edit',
      allow: [],
      ask: [],
      deny: ['Bash(rm -rf *)'],
      usingDefaults: false,
    });
  });

  it('нет файла → дефолт CLI, и он НЕ записан', () => {
    const filePath = join(root, 'absent.json');
    expect(readQwen(filePath)).toEqual({
      kind: 'qwen',
      approvalMode: 'default',
      allow: [],
      ask: [],
      deny: [],
      usingDefaults: true,
    });
  });

  it('режим вне набора показывается дефолтом, но раздел не «на дефолтах»', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, JSON.stringify({ tools: { approvalMode: 'turbo' } }), 'utf8');
    const values = readQwen(filePath);
    expect(values.approvalMode).toBe('default');
    expect(values.usingDefaults).toBe(false);
  });

  it('запись меняет только свои ключи: соседи, устаревший core и mcpServers целы', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');

    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'plan', allow: ['Bash(git status)'], ask: [], deny: ['Bash(rm -rf *)'] },
      backupDir,
    );

    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(config.tools).toEqual({ approvalMode: 'plan', core: ['ReadFile'], sandbox: false });
    expect(config.permissions).toEqual({ deny: ['Bash(rm -rf *)'], allow: ['Bash(git status)'] });
    expect(config.ui).toEqual({ theme: 'Dark' });
    expect(config.mcpServers).toEqual({ probe: { command: 'node', args: ['x.js'] } });
  });

  it('пустые все три списка удаляют объект permissions целиком (а не пишут {})', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');

    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'default', allow: [], ask: [], deny: [] },
      backupDir,
    );

    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    expect('permissions' in config).toBe(false);
    expect(config.tools.approvalMode).toBe('default');
  });

  it('нет файла → создаётся с одним tools.approvalMode', () => {
    const filePath = join(root, 'fresh.json');
    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'plan', allow: [], ask: [], deny: [] },
      backupDir,
    );
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ tools: { approvalMode: 'plan' } });
  });

  it('round-trip: чтение → запись → чтение стабильно', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');

    const before = readQwen(filePath);
    saveProviderPermissions(targetFor(filePath), { ...before }, backupDir);
    expect(readQwen(filePath)).toEqual(before);
  });

  it('yolo РАЗРЕШЁН: у Qwen это задокументированное значение файла настроек', () => {
    expect(parseProviderPermissionsDraft({ approvalMode: 'yolo' }, 'qwen-json')).toEqual({
      approvalMode: 'yolo',
      allow: [],
      ask: [],
      deny: [],
    });

    const filePath = join(root, 'settings.json');
    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'yolo', allow: [], ask: [], deny: [] },
      backupDir,
    );
    expect(readQwen(filePath).approvalMode).toBe('yolo');
  });

  it('черновик валидируется: чужой режим, не массив и не строка — отказ', () => {
    expect(parseProviderPermissionsDraft({ approvalMode: 'turbo' }, 'qwen-json')).toBeUndefined();
    // Форма gemini в qwen-цель не проходит: режима auto_edit у Qwen нет.
    expect(
      parseProviderPermissionsDraft({ approvalMode: 'auto_edit' }, 'qwen-json'),
    ).toBeUndefined();
    expect(
      parseProviderPermissionsDraft({ approvalMode: 'plan', allow: 'Bash' }, 'qwen-json'),
    ).toBeUndefined();
    expect(
      parseProviderPermissionsDraft({ approvalMode: 'plan', deny: [42] }, 'qwen-json'),
    ).toBeUndefined();
    // Повторы схлопываются, пробелы по краям срезаются.
    expect(
      parseProviderPermissionsDraft(
        { approvalMode: 'plan', allow: [' Bash(ls) ', 'Bash(ls)', ''] },
        'qwen-json',
      ),
    ).toEqual({ approvalMode: 'plan', allow: ['Bash(ls)'], ask: [], deny: [] });
  });

  it('битый JSON: чтение и запись fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'broken.json');
    const broken = '{ "tools": { "approvalMode": ';
    writeFileSync(filePath, broken, 'utf8');

    expect(() => readQwen(filePath)).toThrow(UnrecognizedFormatError);
    expect(() =>
      saveProviderPermissions(
        targetFor(filePath),
        { approvalMode: 'plan', allow: [], ask: [], deny: [] },
        backupDir,
      ),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма ключей (permissions.allow строкой, tools массивом) — fail-closed', () => {
    const listFile = join(root, 'list.json');
    writeFileSync(listFile, JSON.stringify({ permissions: { allow: 'Bash' } }), 'utf8');
    expect(() => readQwen(listFile)).toThrow(UnrecognizedFormatError);

    const toolsFile = join(root, 'tools.json');
    writeFileSync(toolsFile, JSON.stringify({ tools: ['approvalMode'] }), 'utf8');
    expect(() => readQwen(toolsFile)).toThrow(UnrecognizedFormatError);
  });
});
