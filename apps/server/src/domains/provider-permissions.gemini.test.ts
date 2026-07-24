import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { BOM_CHAR } from '../lib/text-form.ts';
import {
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  isCliOnlyGeminiApprovalMode,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';

/**
 * GEMINI-2: права в `settings.json` — `general.defaultApprovalMode` плюс списки
 * `coreTools` (белый) и `excludeTools` (чёрный). Проверяем главное: правятся
 * ТОЛЬКО эти три ключа (соседи внутри `general` и весь `mcpServers` целы),
 * `yolo` не проходит валидацию, пустой список удаляет ключ, битый JSON не
 * перезаписывается. Файлы — только во временных каталогах.
 */
describe('Gemini settings.json права: точечная правка трёх ключей', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('gemini'),
    format: 'gemini-json',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до gemini-модели (у цели формат `gemini-json`). */
  const readGemini = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'gemini') throw new Error('ожидалась gemini-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-gemini-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Живой settings.json: тема, MCP-серверы, соседний ключ внутри general.
  const SETTINGS = JSON.stringify(
    {
      theme: 'GitHub',
      general: { preferredEditor: 'vscode', defaultApprovalMode: 'auto_edit' },
      coreTools: ['ReadFile'],
      mcpServers: { probe: { command: 'node', args: ['x.js'] } },
    },
    null,
    2,
  );

  it('чтение отдаёт режим и оба списка', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');
    expect(readGemini(filePath)).toEqual({
      kind: 'gemini',
      approvalMode: 'auto_edit',
      coreTools: ['ReadFile'],
      excludeTools: [],
      usingDefaults: false,
    });
  });

  it('пустой файл → дефолт default, usingDefaults (в файл ничего не пишется)', () => {
    const filePath = join(root, 'settings.json');
    expect(readGemini(filePath)).toEqual({
      kind: 'gemini',
      approvalMode: 'default',
      coreTools: [],
      excludeTools: [],
      usingDefaults: true,
    });
    expect(existsSync(filePath)).toBe(false);
  });

  it('запись меняет только три ключа: theme, mcpServers и сосед в general целы', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');
    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'plan', coreTools: ['ReadFile', 'Shell'], excludeTools: ['WriteFile'] },
      backupDir,
    );

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.theme).toBe('GitHub');
    expect(parsed.mcpServers).toEqual({ probe: { command: 'node', args: ['x.js'] } });
    expect(parsed.general).toEqual({ preferredEditor: 'vscode', defaultApprovalMode: 'plan' });
    expect(parsed.coreTools).toEqual(['ReadFile', 'Shell']);
    expect(parsed.excludeTools).toEqual(['WriteFile']);
    expect(readdirSync(backupDir).some((n) => n.startsWith('gemini-settings.json.'))).toBe(true);
  });

  it('пустой список УДАЛЯЕТ ключ (пустой coreTools означал бы «ничего нельзя»)', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');
    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'default', coreTools: [], excludeTools: [] },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect('coreTools' in parsed).toBe(false);
    expect('excludeTools' in parsed).toBe(false);
  });

  it('форма файла сохраняется: BOM и CRLF остаются', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, `${BOM_CHAR}${SETTINGS.replace(/\n/g, '\r\n')}\r\n`, 'utf8');
    saveProviderPermissions(
      targetFor(filePath),
      { approvalMode: 'plan', coreTools: [], excludeTools: [] },
      backupDir,
    );
    const raw = readFileSync(filePath, 'utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw.includes('\r\n')).toBe(true);
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, SETTINGS, 'utf8');
    const before = readGemini(filePath);
    saveProviderPermissions(
      targetFor(filePath),
      {
        approvalMode: before.approvalMode,
        coreTools: before.coreTools,
        excludeTools: before.excludeTools,
      },
      backupDir,
    );
    expect(readGemini(filePath)).toEqual(before);
  });

  it('битый JSON → и чтение, и запись fail-closed; файл не тронут', () => {
    const filePath = join(root, 'settings.json');
    const broken = '{ "general": ';
    writeFileSync(filePath, broken, 'utf8');
    expect(() => readProviderPermissions(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() =>
      saveProviderPermissions(
        targetFor(filePath),
        { approvalMode: 'plan', coreTools: [], excludeTools: [] },
        backupDir,
      ),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма ключей (general строкой, coreTools не массив) → fail-closed', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, '{ "general": "auto" }', 'utf8');
    expect(() => readProviderPermissions(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    writeFileSync(filePath, '{ "coreTools": "ReadFile" }', 'utf8');
    expect(() => readProviderPermissions(targetFor(filePath))).toThrow(UnrecognizedFormatError);
  });

  it('вписанный вручную yolo читается как default и НЕ считается дефолтом', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, '{ "general": { "defaultApprovalMode": "yolo" } }', 'utf8');
    const values = readGemini(filePath);
    expect(values.approvalMode).toBe('default');
    expect(values.usingDefaults).toBe(false);
  });
});

describe('parseProviderPermissionsDraft: модель gemini', () => {
  const parse = (body: unknown) => parseProviderPermissionsDraft(body, 'gemini-json');

  it('корректный черновик разбирается, пробелы и дубликаты в списках чистятся', () => {
    expect(
      parse({
        approvalMode: 'auto_edit',
        coreTools: [' ReadFile ', 'ReadFile', '', 'Shell'],
        excludeTools: [],
      }),
    ).toEqual({ approvalMode: 'auto_edit', coreTools: ['ReadFile', 'Shell'], excludeTools: [] });
  });

  it('yolo НЕ проходит валидацию (и опознаётся как режим только для флага CLI)', () => {
    expect(parse({ approvalMode: 'yolo', coreTools: [], excludeTools: [] })).toBeUndefined();
    expect(isCliOnlyGeminiApprovalMode({ approvalMode: 'yolo' })).toBe(true);
    expect(isCliOnlyGeminiApprovalMode({ approvalMode: 'plan' })).toBe(false);
  });

  it('прочие невалидные тела отклоняются', () => {
    expect(parse({ approvalMode: 'always', coreTools: [], excludeTools: [] })).toBeUndefined();
    expect(parse({ approvalMode: 'plan', coreTools: 'ReadFile' })).toBeUndefined();
    expect(parse({ approvalMode: 'plan', coreTools: [1] })).toBeUndefined();
    expect(parse(null)).toBeUndefined();
  });

  // Форму задаёт ФАЙЛ провайдера, а не клиент: codex-черновик в gemini не лезет.
  it('codex-черновик под форматом gemini-json отклоняется', () => {
    expect(parse({ approvalPolicy: 'never', sandboxMode: 'read-only' })).toBeUndefined();
  });
});
