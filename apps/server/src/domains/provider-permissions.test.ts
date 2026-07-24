import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { CodexPermissionDraft } from '@claude-control/contracts';
import { getProvider } from '../providers/registry.ts';
import {
  resolveProviderPermissionsTarget,
  readProviderPermissions,
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';

/** Фейковое хранилище настроек. */
function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

/** Разобранный config.toml для проверок. */
interface ParsedToml {
  model?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  mcp_servers?: Record<string, Record<string, unknown>>;
  shell_environment_policy?: Record<string, unknown>;
  profiles?: Record<string, Record<string, unknown>>;
}
const asToml = (text: string): ParsedToml => parseToml(text) as unknown as ParsedToml;

describe('resolveProviderPermissionsTarget: fail-closed по провайдеру', () => {
  it('codex → toml-цель (config.toml)', () => {
    const target = resolveProviderPermissionsTarget(fakeStore('codex'));
    expect(target).toMatchObject({ format: 'toml' });
    expect(target?.filePath.endsWith('config.toml')).toBe(true);
  });

  it('claude → undefined (у него свои роуты прав)', () => {
    expect(resolveProviderPermissionsTarget(fakeStore('claude'))).toBeUndefined();
  });

  it('gemini → gemini-json-цель (settings.json)', () => {
    const target = resolveProviderPermissionsTarget(fakeStore('gemini'));
    expect(target).toMatchObject({ format: 'gemini-json' });
    expect(target?.filePath.endsWith('settings.json')).toBe(true);
  });

  it('opencode (permissions=planned) → undefined', () => {
    expect(resolveProviderPermissionsTarget(fakeStore('opencode'))).toBeUndefined();
  });

  it('cursor/aider → undefined', () => {
    for (const id of ['cursor', 'aider'] as const) {
      expect(resolveProviderPermissionsTarget(fakeStore(id))).toBeUndefined();
    }
  });

  it('незнакомый провайдер откатывается на claude → undefined', () => {
    expect(resolveProviderPermissionsTarget(fakeStore('nonexistent'))).toBeUndefined();
  });
});

describe('parseProviderPermissionsDraft: валидация enum до записи', () => {
  it('корректный набор разбирается', () => {
    expect(
      parseProviderPermissionsDraft({ approvalPolicy: 'never', sandboxMode: 'read-only' }),
    ).toEqual({ approvalPolicy: 'never', sandboxMode: 'read-only' });
  });
  it('невалидная политика аппрувов → отклоняется', () => {
    expect(
      parseProviderPermissionsDraft({ approvalPolicy: 'always', sandboxMode: 'read-only' }),
    ).toBeUndefined();
  });
  it('невалидный режим песочницы → отклоняется', () => {
    expect(
      parseProviderPermissionsDraft({ approvalPolicy: 'never', sandboxMode: 'full' }),
    ).toBeUndefined();
  });
  it('отсутствующие ключи / не объект → отклоняется', () => {
    expect(parseProviderPermissionsDraft({ approvalPolicy: 'never' })).toBeUndefined();
    expect(parseProviderPermissionsDraft(null)).toBeUndefined();
    expect(parseProviderPermissionsDraft('x')).toBeUndefined();
  });
});

describe('Codex TOML права: хирургическая правка скаляров корня', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('codex'),
    format: 'toml',
    filePath,
    cliDetected: false,
  });

  const draft = (
    approvalPolicy: CodexPermissionDraft['approvalPolicy'],
    sandboxMode: CodexPermissionDraft['sandboxMode'],
  ): CodexPermissionDraft => ({ approvalPolicy, sandboxMode });

  /** Чтение с сужением до codex-модели (у цели формат `toml`). */
  const readCodex = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'codex') throw new Error('ожидалась codex-модель прав');
    return values;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-codex-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Файл с моделью, обоими корневыми ключами, mcp_servers, политикой окружения,
  // комментариями И профилем с ОДНОИМЁННЫМИ ключами (в [profiles.x]) — их трогать нельзя.
  const CONFIG = `# Codex config
model = "gpt-5"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[shell_environment_policy]
set = { CI = "1" }

# существующий MCP-сервер
[mcp_servers.existing]
command = "node"
args = ["server.js"]

[profiles.safe]
approval_policy = "untrusted"
sandbox_mode = "read-only"
`;

  it('чтение возвращает корневые значения', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    expect(readCodex(filePath)).toEqual({
      kind: 'codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      usingDefaults: false,
    });
  });

  it('правка обоих ключей: одноимённые ключи в [profiles.safe] НЕ тронуты, таблицы/комментарии целы', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    saveProviderPermissions(targetFor(filePath), draft('never', 'danger-full-access'), backupDir);
    const text = readFileSync(filePath, 'utf8');

    // Вне правки — байт-в-байт: модель, комментарии, mcp_servers, env-политика.
    expect(text).toContain('# Codex config');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('# существующий MCP-сервер');

    const parsed = asToml(text);
    // Корневые значения — новое намерение.
    expect(parsed.approval_policy).toBe('never');
    expect(parsed.sandbox_mode).toBe('danger-full-access');
    // Одноимённые ключи ВНУТРИ профиля целы (не тронуты).
    expect(parsed.profiles?.safe?.approval_policy).toBe('untrusted');
    expect(parsed.profiles?.safe?.sandbox_mode).toBe('read-only');
    // Чужие секции целы.
    expect(parsed.mcp_servers?.existing).toEqual({ command: 'node', args: ['server.js'] });
    expect(parsed.shell_environment_policy?.set).toEqual({ CI: '1' });
  });

  it('вставка при отсутствии ключей: добавляются в корень, model и таблицы целы', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(
      filePath,
      'model = "gpt-5"\n\n[profiles.safe]\napproval_policy = "untrusted"\n',
      'utf8',
    );
    saveProviderPermissions(targetFor(filePath), draft('untrusted', 'read-only'), backupDir);
    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    const parsed = asToml(text);
    // Корневые ключи добавлены.
    expect(parsed.approval_policy).toBe('untrusted');
    expect(parsed.sandbox_mode).toBe('read-only');
    // Одноимённый ключ в профиле не тронут.
    expect(parsed.profiles?.safe?.approval_policy).toBe('untrusted');
    expect(parsed.profiles?.safe?.sandbox_mode).toBeUndefined();
  });

  it('нет файла → создаётся только с двумя корневыми скалярами', () => {
    const filePath = join(root, '.codex', 'config.toml');
    saveProviderPermissions(targetFor(filePath), draft('never', 'read-only'), backupDir);
    expect(existsSync(filePath)).toBe(true);
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.approval_policy).toBe('never');
    expect(parsed.sandbox_mode).toBe('read-only');
    expect(Object.keys(parsed).sort()).toEqual(['approval_policy', 'sandbox_mode']);
  });

  it('пустой файл → чтение отдаёт дефолты codex (usingDefaults), ничего не пишет', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, '', 'utf8');
    expect(readCodex(filePath)).toEqual({
      kind: 'codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      usingDefaults: true,
    });
  });

  it('нет ключей в непустом файле → дефолты, но usingDefaults', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, 'model = "gpt-5"\n', 'utf8');
    expect(readCodex(filePath)).toEqual({
      kind: 'codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      usingDefaults: true,
    });
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    const before = readCodex(filePath);
    saveProviderPermissions(
      targetFor(filePath),
      draft(before.approvalPolicy, before.sandboxMode),
      backupDir,
    );
    const after = readCodex(filePath);
    expect(after).toEqual(before);
  });

  it('повторная запись создаёт резервную копию', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    saveProviderPermissions(targetFor(filePath), draft('never', 'read-only'), backupDir);
    saveProviderPermissions(targetFor(filePath), draft('untrusted', 'workspace-write'), backupDir);
    const backups = readdirSync(backupDir).filter((n) => n.endsWith('.bak'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('непарсящийся TOML → отказ записи (fail-closed), файл не тронут', () => {
    const filePath = join(root, 'config.toml');
    const broken = 'model = "gpt-5\napproval_policy =';
    writeFileSync(filePath, broken, 'utf8');
    expect(() =>
      saveProviderPermissions(targetFor(filePath), draft('never', 'read-only'), backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('непарсящийся TOML → чтение тоже бросает (раздел только для чтения)', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, 'approval_policy =\n[', 'utf8');
    expect(() => readProviderPermissions(targetFor(filePath))).toThrow(UnrecognizedFormatError);
  });

  it('значение вне enum в файле → чтение отдаёт дефолт (не usingDefaults, ключ присутствует)', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, 'approval_policy = "bogus"\n', 'utf8');
    const values = readCodex(filePath);
    expect(values.approvalPolicy).toBe('on-request');
    expect(values.usingDefaults).toBe(false);
  });
});
