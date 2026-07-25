import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
 * Права Kimi Code — седьмая модель прав и вторая на TOML: скалярный
 * `default_permission_mode` в корне плюс массив таблиц `[[permission.rules]]`
 * (`decision` + `pattern`). Проверяем ровно то, что задокументировано, и
 * fail-closed на всём остальном: чужой ключ внутри `[permission]`, чужое поле
 * правила, незнакомое решение — раздел только для чтения, файл не меняется.
 * Отдельно — что прочие ключи `config.toml` (провайдеры, хуки, таймауты MCP)
 * переживают запись байт-в-байт.
 */
describe('Kimi config.toml: режим аппрувов и правила', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('kimi'),
    format: 'kimi-toml',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до kimi-модели. */
  const readKimi = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'kimi') throw new Error('ожидалась kimi-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-kimi-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const CONFIG = `# конфигурация Kimi Code
model = "kimi-k2"
default_permission_mode = "auto"

[mcp]
startup_timeout_ms = 10000

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "allow"
pattern = "Read"

[providers.moonshot]
base_url = "https://api.moonshot.ai/v1"
`;

  it('чтение отдаёт режим и правила В ПОРЯДКЕ файла', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'auto',
      rules: [
        { decision: 'deny', pattern: 'Bash(rm -rf*)' },
        { decision: 'allow', pattern: 'Read' },
      ],
      usingDefaults: false,
    });
  });

  it('нет файла → дефолт CLI (manual) без правил, и он НЕ записан', () => {
    const filePath = join(root, 'absent.toml');
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'manual',
      rules: [],
      usingDefaults: true,
    });
    expect(existsSync(filePath)).toBe(false);
  });

  it('файл есть, ни режима, ни правил → «на дефолтах»', () => {
    const filePath = join(root, 'other.toml');
    writeFileSync(filePath, `model = "kimi-k2"\n`, 'utf8');
    expect(readKimi(filePath)).toMatchObject({ mode: 'manual', rules: [], usingDefaults: true });
  });

  it('только правила, без режима → дефолт показан, но раздел уже НЕ на дефолтах', () => {
    const filePath = join(root, 'rules-only.toml');
    writeFileSync(filePath, `[[permission.rules]]\ndecision = "ask"\npattern = "Write"\n`, 'utf8');
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'manual',
      rules: [{ decision: 'ask', pattern: 'Write' }],
      usingDefaults: false,
    });
  });

  it('незнакомый режим: показываем дефолт, но настройка чужая — не «на дефолтах»', () => {
    const filePath = join(root, 'unknown.toml');
    writeFileSync(filePath, `default_permission_mode = "turbo"\n`, 'utf8');
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'manual',
      rules: [],
      usingDefaults: false,
    });
  });

  it('запись правит только свои места: прочие ключи и комментарий целы', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    saveProviderPermissions(
      targetFor(filePath),
      { mode: 'yolo', rules: [{ decision: 'ask', pattern: 'Bash(git push*)' }] },
      backupDir,
    );

    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('# конфигурация Kimi Code');
    expect(text).toContain('model = "kimi-k2"');
    expect(text).toContain('startup_timeout_ms = 10000');
    expect(text).toContain('base_url = "https://api.moonshot.ai/v1"');
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'yolo',
      rules: [{ decision: 'ask', pattern: 'Bash(git push*)' }],
      usingDefaults: false,
    });
  });

  it('пустой список правил УДАЛЯЕТ регион [[permission.rules]], режим остаётся', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    saveProviderPermissions(targetFor(filePath), { mode: 'manual', rules: [] }, backupDir);

    const text = readFileSync(filePath, 'utf8');
    expect(text).not.toContain('permission.rules');
    expect(text).toContain('startup_timeout_ms = 10000');
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'manual',
      rules: [],
      usingDefaults: false,
    });
  });

  it('нет файла → создаётся с режимом и правилами', () => {
    const filePath = join(root, 'fresh.toml');
    saveProviderPermissions(
      targetFor(filePath),
      { mode: 'auto', rules: [{ decision: 'deny', pattern: 'Bash(curl*)' }] },
      backupDir,
    );
    expect(readKimi(filePath)).toEqual({
      kind: 'kimi',
      mode: 'auto',
      rules: [{ decision: 'deny', pattern: 'Bash(curl*)' }],
      usingDefaults: false,
    });
  });

  it('round-trip: чтение → запись → чтение стабильно', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    const before = readKimi(filePath);
    saveProviderPermissions(
      targetFor(filePath),
      { mode: before.mode, rules: before.rules },
      backupDir,
    );
    expect(readKimi(filePath)).toEqual(before);
  });

  it('черновик: режимы из набора, правила чистятся и дедуплицируются', () => {
    for (const mode of ['manual', 'auto', 'yolo']) {
      expect(parseProviderPermissionsDraft({ mode, rules: [] }, 'kimi-toml')).toEqual({
        mode,
        rules: [],
      });
    }

    expect(
      parseProviderPermissionsDraft(
        {
          mode: 'auto',
          rules: [
            { decision: 'allow', pattern: '  Read  ' },
            { decision: 'allow', pattern: 'Read' },
            { decision: 'deny', pattern: '   ' },
            { decision: 'deny', pattern: 'Bash(rm*)' },
          ],
        },
        'kimi-toml',
      ),
    ).toEqual({
      mode: 'auto',
      rules: [
        { decision: 'allow', pattern: 'Read' },
        { decision: 'deny', pattern: 'Bash(rm*)' },
      ],
    });

    expect(
      parseProviderPermissionsDraft({ mode: 'turbo', rules: [] }, 'kimi-toml'),
    ).toBeUndefined();
    expect(
      parseProviderPermissionsDraft(
        { mode: 'auto', rules: [{ decision: 'maybe', pattern: 'Read' }] },
        'kimi-toml',
      ),
    ).toBeUndefined();
    expect(parseProviderPermissionsDraft({ rules: [] }, 'kimi-toml')).toBeUndefined();
  });

  it('чужой ключ внутри [permission] — fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'foreign.toml');
    const original = `[permission]\nmode = "auto"\n\n[[permission.rules]]\ndecision = "allow"\npattern = "Read"\n`;
    writeFileSync(filePath, original, 'utf8');

    expect(() => readKimi(filePath)).toThrow(UnrecognizedFormatError);
    expect(() =>
      saveProviderPermissions(targetFor(filePath), { mode: 'auto', rules: [] }, backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('чужое поле правила и незнакомое решение — fail-closed', () => {
    const extraField = join(root, 'extra.toml');
    writeFileSync(
      extraField,
      `[[permission.rules]]\ndecision = "allow"\npattern = "Read"\nscope = "project"\n`,
      'utf8',
    );
    expect(() => readKimi(extraField)).toThrow(UnrecognizedFormatError);

    const badDecision = join(root, 'decision.toml');
    writeFileSync(
      badDecision,
      `[[permission.rules]]\ndecision = "maybe"\npattern = "Read"\n`,
      'utf8',
    );
    expect(() => readKimi(badDecision)).toThrow(UnrecognizedFormatError);

    const emptyPattern = join(root, 'pattern.toml');
    writeFileSync(emptyPattern, `[[permission.rules]]\ndecision = "allow"\npattern = ""\n`, 'utf8');
    expect(() => readKimi(emptyPattern)).toThrow(UnrecognizedFormatError);
  });

  it('битый TOML и чужая форма режима: чтение и запись fail-closed', () => {
    const broken = join(root, 'broken.toml');
    const text = 'default_permission_mode = "auto\nmodel = "kimi"\n';
    writeFileSync(broken, text, 'utf8');
    expect(() => readKimi(broken)).toThrow(UnrecognizedFormatError);
    expect(() =>
      saveProviderPermissions(targetFor(broken), { mode: 'auto', rules: [] }, backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(broken, 'utf8')).toBe(text);

    const asList = join(root, 'list.toml');
    writeFileSync(asList, `default_permission_mode = ["auto"]\n`, 'utf8');
    expect(() => readKimi(asList)).toThrow(UnrecognizedFormatError);
  });
});
