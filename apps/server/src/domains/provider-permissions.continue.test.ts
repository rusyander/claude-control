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
 * Права Continue — самая простая из пяти моделей: ОТДЕЛЬНЫЙ файл
 * `~/.continue/permissions.yaml` с тремя списками верхнего уровня
 * `allow`/`ask`/`exclude` и БЕЗ режима-переключателя. Проверяем: чтение трёх
 * списков, «на дефолтах» только когда ни одного ключа нет (пустой `exclude: []`
 * пользователя — это уже настройка), пустой список удаляет свой ключ, чужие
 * ключи и комментарии файла целы, битый YAML не перезаписывается.
 */
describe('Continue permissions.yaml: три списка без режима', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('continue'),
    format: 'continue-yaml',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до continue-модели. */
  const readContinue = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'continue') throw new Error('ожидалась continue-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-continue-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const PERMISSIONS = `# права инструментов CLI cn
allow:
  - Read(**)
  - Bash(git status)
ask:
  - Write(**)
exclude:
  - Bash(rm -rf *)
`;

  it('чтение отдаёт все три списка', () => {
    const filePath = join(root, 'permissions.yaml');
    writeFileSync(filePath, PERMISSIONS, 'utf8');
    expect(readContinue(filePath)).toEqual({
      kind: 'continue',
      allow: ['Read(**)', 'Bash(git status)'],
      ask: ['Write(**)'],
      exclude: ['Bash(rm -rf *)'],
      usingDefaults: false,
    });
  });

  it('нет файла → дефолты CLI, и они НЕ записаны', () => {
    const filePath = join(root, 'absent.yaml');
    expect(readContinue(filePath)).toEqual({
      kind: 'continue',
      allow: [],
      ask: [],
      exclude: [],
      usingDefaults: true,
    });
    expect(existsSync(filePath)).toBe(false);
  });

  it('файл без ведомых ключей — «на дефолтах»; пустой exclude: [] — уже настройка', () => {
    const onlyOther = join(root, 'other.yaml');
    writeFileSync(onlyOther, `something: else\n`, 'utf8');
    expect(readContinue(onlyOther).usingDefaults).toBe(true);

    const emptyList = join(root, 'empty-list.yaml');
    writeFileSync(emptyList, `exclude: []\n`, 'utf8');
    expect(readContinue(emptyList)).toMatchObject({ exclude: [], usingDefaults: false });
  });

  it('одиночная строка — краткая форма списка из одного правила', () => {
    const filePath = join(root, 'short.yaml');
    writeFileSync(filePath, `allow: Read(**)\n`, 'utf8');
    expect(readContinue(filePath).allow).toEqual(['Read(**)']);
  });

  it('запись меняет только свои ключи: чужие ключи и комментарии целы', () => {
    const filePath = join(root, 'permissions.yaml');
    writeFileSync(filePath, `# заголовок файла\nunmanaged: keep me\n${PERMISSIONS}`, 'utf8');

    saveProviderPermissions(
      targetFor(filePath),
      { allow: ['Read(**)'], ask: ['Write(**)', 'Bash(*)'], exclude: ['Bash(rm -rf *)'] },
      backupDir,
    );

    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('# заголовок файла');
    expect(parseYaml(text)).toEqual({
      unmanaged: 'keep me',
      allow: ['Read(**)'],
      ask: ['Write(**)', 'Bash(*)'],
      exclude: ['Bash(rm -rf *)'],
    });
  });

  it('пустой список удаляет свой ключ (а не пишет [])', () => {
    const filePath = join(root, 'permissions.yaml');
    writeFileSync(filePath, PERMISSIONS, 'utf8');

    saveProviderPermissions(
      targetFor(filePath),
      { allow: ['Read(**)'], ask: [], exclude: [] },
      backupDir,
    );

    const text = readFileSync(filePath, 'utf8');
    expect(text).not.toContain('ask:');
    expect(text).not.toContain('exclude:');
    expect(parseYaml(text)).toEqual({ allow: ['Read(**)'] });
  });

  it('нет файла → создаётся только с непустыми списками', () => {
    const filePath = join(root, 'fresh.yaml');
    saveProviderPermissions(
      targetFor(filePath),
      { allow: [], ask: [], exclude: ['Bash(curl *)'] },
      backupDir,
    );
    expect(parseYaml(readFileSync(filePath, 'utf8'))).toEqual({ exclude: ['Bash(curl *)'] });
  });

  it('round-trip: чтение → запись → чтение стабильно', () => {
    const filePath = join(root, 'permissions.yaml');
    writeFileSync(filePath, PERMISSIONS, 'utf8');

    const before = readContinue(filePath);
    saveProviderPermissions(targetFor(filePath), { ...before }, backupDir);
    expect(readContinue(filePath)).toEqual(before);
  });

  it('черновик: режима нет вовсе, повторы схлопываются, не-строки отклоняются', () => {
    expect(
      parseProviderPermissionsDraft({ allow: [' Read(**) ', 'Read(**)', ''] }, 'continue-yaml'),
    ).toEqual({ allow: ['Read(**)'], ask: [], exclude: [] });
    // Лишний ключ режима игнорируется, но тело БЕЗ единого списка — не черновик:
    // иначе `{}` или чужой черновик прочитались бы как «всё пусто» и стёрли файл.
    expect(
      parseProviderPermissionsDraft({ approvalMode: 'yolo', ask: [] }, 'continue-yaml'),
    ).toEqual({ allow: [], ask: [], exclude: [] });
    expect(
      parseProviderPermissionsDraft({ approvalMode: 'yolo' }, 'continue-yaml'),
    ).toBeUndefined();
    expect(parseProviderPermissionsDraft({}, 'continue-yaml')).toBeUndefined();
    expect(parseProviderPermissionsDraft({ allow: 'Read' }, 'continue-yaml')).toBeUndefined();
    expect(parseProviderPermissionsDraft({ exclude: [42] }, 'continue-yaml')).toBeUndefined();
  });

  it('битый YAML: чтение и запись fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'broken.yaml');
    const broken = 'allow:\n  - Read(**)\n - Bash\n';
    writeFileSync(filePath, broken, 'utf8');

    expect(() => readContinue(filePath)).toThrow(UnrecognizedFormatError);
    expect(() =>
      saveProviderPermissions(
        targetFor(filePath),
        { allow: ['Read(**)'], ask: [], exclude: [] },
        backupDir,
      ),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма списка (карта вместо строк, корень-список) — fail-closed', () => {
    const asMap = join(root, 'map.yaml');
    writeFileSync(asMap, `allow:\n  Read: true\n`, 'utf8');
    expect(() => readContinue(asMap)).toThrow(UnrecognizedFormatError);

    const withMapItem = join(root, 'item.yaml');
    writeFileSync(withMapItem, `ask:\n  - tool: Write\n`, 'utf8');
    expect(() => readContinue(withMapItem)).toThrow(UnrecognizedFormatError);

    const seqRoot = join(root, 'seq.yaml');
    writeFileSync(seqRoot, `- allow\n- ask\n`, 'utf8');
    expect(() => readContinue(seqRoot)).toThrow(UnrecognizedFormatError);
  });
});
