import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';

/**
 * Права Goose — самая короткая из шести моделей: ОДИН скалярный ключ КОРНЯ
 * `GOOSE_MODE` в общем `config.yaml`, где рядом лежат расширения и настройки
 * провайдера. Проверяем: ключа нет → дефолт CLI и файл не создаётся; незнакомое
 * значение показывается дефолтом, но «на дефолтах» уже НЕ считается; запись не
 * трогает ни расширения, ни комментарии; чужие формы значения — fail-closed.
 */
describe('Goose config.yaml: режим аппрувов GOOSE_MODE', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('goose'),
    format: 'goose-yaml',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до goose-модели. */
  const readGoose = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'goose') throw new Error('ожидалась goose-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-goose-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const CONFIG = `# конфигурация Goose
GOOSE_PROVIDER: anthropic
GOOSE_MODE: approve
extensions:
  developer:
    type: builtin
    name: developer
    enabled: true
`;

  it('чтение отдаёт записанный режим', () => {
    const filePath = join(root, 'config.yaml');
    writeFileSync(filePath, CONFIG, 'utf8');
    expect(readGoose(filePath)).toEqual({ kind: 'goose', mode: 'approve', usingDefaults: false });
  });

  it('нет файла → дефолт CLI (auto), и он НЕ записан', () => {
    const filePath = join(root, 'absent.yaml');
    expect(readGoose(filePath)).toEqual({ kind: 'goose', mode: 'auto', usingDefaults: true });
    expect(existsSync(filePath)).toBe(false);
  });

  it('файл есть, ключа нет → дефолт и «на дефолтах»', () => {
    const filePath = join(root, 'other.yaml');
    writeFileSync(filePath, `GOOSE_PROVIDER: anthropic\n`, 'utf8');
    expect(readGoose(filePath)).toEqual({ kind: 'goose', mode: 'auto', usingDefaults: true });
  });

  it('незнакомое значение: показываем дефолт, но настройка чужая — не «на дефолтах»', () => {
    const filePath = join(root, 'unknown.yaml');
    writeFileSync(filePath, `GOOSE_MODE: yolo\n`, 'utf8');
    expect(readGoose(filePath)).toEqual({ kind: 'goose', mode: 'auto', usingDefaults: false });
  });

  it('запись меняет только свой ключ: расширения и комментарии целы', () => {
    const filePath = join(root, 'config.yaml');
    writeFileSync(filePath, CONFIG, 'utf8');

    saveProviderPermissions(targetFor(filePath), { mode: 'smart_approve' }, backupDir);

    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('# конфигурация Goose');
    expect(parseYaml(text)).toEqual({
      GOOSE_PROVIDER: 'anthropic',
      GOOSE_MODE: 'smart_approve',
      extensions: { developer: { type: 'builtin', name: 'developer', enabled: true } },
    });
  });

  it('нет файла → создаётся с одним ключом режима', () => {
    const filePath = join(root, 'fresh.yaml');
    saveProviderPermissions(targetFor(filePath), { mode: 'chat' }, backupDir);
    expect(parseYaml(readFileSync(filePath, 'utf8'))).toEqual({ GOOSE_MODE: 'chat' });
  });

  it('запись поверх незнакомого значения приводит ключ к известному режиму', () => {
    const filePath = join(root, 'unknown.yaml');
    writeFileSync(filePath, `GOOSE_MODE: yolo\n`, 'utf8');
    saveProviderPermissions(targetFor(filePath), { mode: 'approve' }, backupDir);
    expect(readGoose(filePath)).toEqual({ kind: 'goose', mode: 'approve', usingDefaults: false });
  });

  it('round-trip: чтение → запись → чтение стабильно', () => {
    const filePath = join(root, 'config.yaml');
    writeFileSync(filePath, CONFIG, 'utf8');

    const before = readGoose(filePath);
    saveProviderPermissions(targetFor(filePath), { mode: before.mode }, backupDir);
    expect(readGoose(filePath)).toEqual(before);
  });

  it('черновик: только известные режимы, списков у модели нет', () => {
    for (const mode of ['auto', 'approve', 'smart_approve', 'chat']) {
      expect(parseProviderPermissionsDraft({ mode }, 'goose-yaml')).toEqual({ mode });
    }
    // Лишние ключи игнорируются: списков правил у Goose нет.
    expect(parseProviderPermissionsDraft({ mode: 'chat', allow: ['Read'] }, 'goose-yaml')).toEqual({
      mode: 'chat',
    });
    expect(parseProviderPermissionsDraft({ mode: 'yolo' }, 'goose-yaml')).toBeUndefined();
    expect(parseProviderPermissionsDraft({ mode: 42 }, 'goose-yaml')).toBeUndefined();
    expect(parseProviderPermissionsDraft({}, 'goose-yaml')).toBeUndefined();
  });

  it('битый YAML: чтение и запись fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'broken.yaml');
    const broken = 'GOOSE_MODE: approve\nextensions:\n  x: [stdio\n';
    writeFileSync(filePath, broken, 'utf8');

    expect(() => readGoose(filePath)).toThrow(UnrecognizedFormatError);
    expect(() => saveProviderPermissions(targetFor(filePath), { mode: 'chat' }, backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма значения (карта, список, корень-список) — fail-closed', () => {
    const asMap = join(root, 'map.yaml');
    writeFileSync(asMap, `GOOSE_MODE:\n  value: approve\n`, 'utf8');
    expect(() => readGoose(asMap)).toThrow(UnrecognizedFormatError);

    const asList = join(root, 'list.yaml');
    writeFileSync(asList, `GOOSE_MODE:\n  - approve\n`, 'utf8');
    expect(() => readGoose(asList)).toThrow(UnrecognizedFormatError);

    const seqRoot = join(root, 'seq.yaml');
    writeFileSync(seqRoot, `- GOOSE_MODE\n`, 'utf8');
    expect(() => readGoose(seqRoot)).toThrow(UnrecognizedFormatError);
  });
});
