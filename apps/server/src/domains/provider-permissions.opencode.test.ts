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
  buildProviderPermissionInfo,
  UnrecognizedFormatError,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';

/**
 * OPENCODE-1: права в `opencode.json` — ключ `permission`. Проверяем главное:
 * правится ТОЛЬКО этот ключ (`$schema`, `model`, `mcp`, `agent` целы), обе формы
 * (уровень и карта шаблонов `bash`) читаются и пишутся, незнакомые записи внутри
 * `permission` сохраняются и не переписываются, значение вне набора не проходит
 * валидацию, битый JSON не перезаписывается. Файлы — только во временных
 * каталогах, домашний каталог пользователя не затрагивается.
 */
describe('OpenCode opencode.json: права в ключе permission', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderPermissionsTarget => ({
    provider: getProvider('opencode'),
    format: 'opencode-json',
    filePath,
    cliDetected: false,
  });

  /** Чтение с сужением до opencode-модели (у цели формат `opencode-json`). */
  const readOpencode = (filePath: string) => {
    const values = readProviderPermissions(targetFor(filePath));
    if (values.kind !== 'opencode') throw new Error('ожидалась opencode-модель прав');
    return values;
  };

  const save = (filePath: string, body: unknown): string | undefined => {
    const draft = parseProviderPermissionsDraft(body, 'opencode-json');
    if (!draft) throw new Error('черновик не прошёл разбор');
    return saveProviderPermissions(targetFor(filePath), draft, backupDir);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-opencode-perm-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Живой opencode.json: схема, модель, MCP-серверы, агенты и права. */
  const CONFIG = JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4',
      mcp: { probe: { type: 'local', command: ['node', 'x.js'], enabled: true } },
      agent: { review: { permission: { edit: 'deny' } } },
      permission: { edit: 'deny', bash: 'ask', webfetch: 'allow' },
    },
    null,
    2,
  );

  // --- Чтение ----------------------------------------------------------------

  it('читает простую форму: уровень у каждого задокументированного инструмента', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    const values = readOpencode(filePath);
    expect(values.usingDefaults).toBe(false);
    expect(values.entries).toEqual([
      { tool: 'edit', mode: 'level', level: 'deny' },
      { tool: 'bash', mode: 'level', level: 'ask' },
      { tool: 'webfetch', mode: 'level', level: 'allow' },
    ]);
    expect(values.preserved).toEqual([]);
  });

  it('читает расширенную форму bash: карту шаблонов в порядке файла', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        permission: { bash: { '*': 'ask', 'git *': 'allow', 'git push *': 'deny' } },
      }),
    );

    const values = readOpencode(filePath);
    expect(values.entries).toEqual([
      {
        tool: 'bash',
        mode: 'patterns',
        patterns: [
          { pattern: '*', level: 'ask' },
          { pattern: 'git *', level: 'allow' },
          { pattern: 'git push *', level: 'deny' },
        ],
      },
    ]);
  });

  it('нет файла или нет ключа permission → ограничений нет, дефолт не записан', () => {
    const missing = join(root, 'absent.json');
    expect(readOpencode(missing)).toEqual({
      kind: 'opencode',
      entries: [],
      preserved: [],
      usingDefaults: true,
    });
    expect(existsSync(missing)).toBe(false);

    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, JSON.stringify({ model: 'x' }));
    expect(readOpencode(filePath).usingDefaults).toBe(true);
  });

  it('незнакомые записи внутри permission показываются отдельно и только для чтения', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        permission: {
          edit: 'deny',
          // Чужое имя инструмента и расширенная форма там, где панель её не ведёт.
          patch: 'ask',
          webfetch: { 'https://*': 'allow' },
        },
      }),
    );

    const values = readOpencode(filePath);
    expect(values.entries).toEqual([{ tool: 'edit', mode: 'level', level: 'deny' }]);
    expect(values.preserved).toEqual([
      { key: 'patch', value: '"ask"' },
      { key: 'webfetch', value: '{"https://*":"allow"}' },
    ]);
  });

  it('битый JSON и permission не-объект → fail-closed на чтении', () => {
    const broken = join(root, 'broken.json');
    writeFileSync(broken, '{ "permission": ');
    expect(() => readOpencode(broken)).toThrow(UnrecognizedFormatError);

    const wrong = join(root, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ permission: 'allow' }));
    expect(() => readOpencode(wrong)).toThrow(UnrecognizedFormatError);
  });

  // --- Разбор черновика (валидация ДО записи) --------------------------------

  it('валидация черновика: уровень строго из набора, форма — только заявленная', () => {
    const ok = parseProviderPermissionsDraft(
      { entries: [{ tool: 'bash', mode: 'level', level: 'ask' }] },
      'opencode-json',
    );
    expect(ok).toEqual({ entries: [{ tool: 'bash', mode: 'level', level: 'ask' }] });

    const rejected: unknown[] = [
      {},
      { entries: 'nope' },
      { entries: [{ tool: 'bash', mode: 'level', level: 'maybe' }] },
      { entries: [{ tool: 'bash', mode: 'level', level: 'ALLOW' }] },
      { entries: [{ tool: 'read', mode: 'level', level: 'allow' }] },
      { entries: [{ tool: 'bash', mode: 'level' }] },
      { entries: [{ tool: 'bash', mode: 'else', level: 'allow' }] },
      // Карта шаблонов задокументирована только у bash.
      { entries: [{ tool: 'edit', mode: 'patterns', patterns: [{ pattern: '*', level: 'ask' }] }] },
      // Пустая карта бессмысленна: «не задано» выражается отсутствием инструмента.
      { entries: [{ tool: 'bash', mode: 'patterns', patterns: [] }] },
      { entries: [{ tool: 'bash', mode: 'patterns', patterns: [{ pattern: ' ', level: 'ask' }] }] },
      { entries: [{ tool: 'bash', mode: 'patterns', patterns: [{ pattern: '*', level: 'x' }] }] },
      // Один инструмент дважды — противоречивый черновик.
      {
        entries: [
          { tool: 'bash', mode: 'level', level: 'ask' },
          { tool: 'bash', mode: 'level', level: 'deny' },
        ],
      },
    ];
    for (const body of rejected) {
      expect(parseProviderPermissionsDraft(body, 'opencode-json')).toBeUndefined();
    }
  });

  it('повторный шаблон внутри одной карты схлопывается (остаётся первый)', () => {
    const draft = parseProviderPermissionsDraft(
      {
        entries: [
          {
            tool: 'bash',
            mode: 'patterns',
            patterns: [
              { pattern: 'git *', level: 'allow' },
              { pattern: ' git * ', level: 'deny' },
            ],
          },
        ],
      },
      'opencode-json',
    );
    expect(draft).toEqual({
      entries: [
        { tool: 'bash', mode: 'patterns', patterns: [{ pattern: 'git *', level: 'allow' }] },
      ],
    });
  });

  // --- Запись ----------------------------------------------------------------

  it('запись меняет только permission: $schema, model, mcp и agent целы', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    const backupPath = save(filePath, {
      entries: [
        { tool: 'edit', mode: 'level', level: 'allow' },
        { tool: 'bash', mode: 'level', level: 'deny' },
      ],
    });
    expect(backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const before = JSON.parse(CONFIG) as Record<string, unknown>;
    expect(written.$schema).toEqual(before.$schema);
    expect(written.model).toEqual(before.model);
    expect(written.mcp).toEqual(before.mcp);
    // Права уровня АГЕНТА — вне области задачи и не тронуты.
    expect(written.agent).toEqual(before.agent);
    // `webfetch` в черновике не было → ключ удалён (ограничение снято).
    expect(written.permission).toEqual({ edit: 'allow', bash: 'deny' });

    // Копия сделана и лежит под именем провайдера, временных файлов не осталось.
    expect(readdirSync(backupDir).some((name) => name.startsWith('opencode-opencode.json'))).toBe(
      true,
    );
    expect(readdirSync(root).some((name) => name.startsWith('.tmp-'))).toBe(false);
  });

  it('карта шаблонов bash записывается объектом и читается обратно', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    save(filePath, {
      entries: [
        {
          tool: 'bash',
          mode: 'patterns',
          patterns: [
            { pattern: '*', level: 'ask' },
            { pattern: 'git *', level: 'allow' },
            { pattern: 'git push *', level: 'deny' },
          ],
        },
      ],
    });

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(written.permission).toEqual({
      bash: { '*': 'ask', 'git *': 'allow', 'git push *': 'deny' },
    });

    const values = readOpencode(filePath);
    expect(values.entries[0]?.mode).toBe('patterns');
    expect(values.entries[0]?.patterns).toHaveLength(3);
  });

  it('пустой черновик удаляет ключ permission целиком, а не пишет {}', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    save(filePath, { entries: [] });

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect('permission' in written).toBe(false);
    expect(written.model).toBe('anthropic/claude-sonnet-4');
  });

  it('незнакомые записи permission переживают запись и не могут быть перезаписаны', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({ permission: { patch: 'ask', webfetch: { 'https://*': 'allow' } } }, null, 2),
    );

    save(filePath, { entries: [{ tool: 'bash', mode: 'level', level: 'deny' }] });

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as {
      permission: Record<string, unknown>;
    };
    expect(written.permission.patch).toBe('ask');
    expect(written.permission.webfetch).toEqual({ 'https://*': 'allow' });
    expect(written.permission.bash).toBe('deny');

    // Попытка переписать НЕ ведомую запись — fail-closed, файл не меняется.
    const before = readFileSync(filePath, 'utf8');
    expect(() =>
      save(filePath, { entries: [{ tool: 'webfetch', mode: 'level', level: 'allow' }] }),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('нет файла → создаётся только с ключом permission', () => {
    const filePath = join(root, 'nested', 'opencode.json');
    save(filePath, { entries: [{ tool: 'edit', mode: 'level', level: 'ask' }] });

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ permission: { edit: 'ask' } });
  });

  it('BOM и CRLF исходного файла сохраняются', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, `${BOM_CHAR}${CONFIG.replace(/\n/g, '\r\n')}`);

    save(filePath, { entries: [{ tool: 'edit', mode: 'level', level: 'ask' }] });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw.startsWith(BOM_CHAR)).toBe(true);
    expect(raw.includes('\r\n')).toBe(true);
  });

  it('битый JSON не перезаписывается: 422-ветка, файл байт-в-байт', () => {
    const filePath = join(root, 'opencode.json');
    const broken = '{ "permission": { "edit": ';
    writeFileSync(filePath, broken);

    expect(() =>
      save(filePath, { entries: [{ tool: 'edit', mode: 'level', level: 'ask' }] }),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
    expect(existsSync(backupDir)).toBe(false);
  });

  // --- Сводка для клиента ----------------------------------------------------

  it('сводка отдаёт наборы для селектов, а на битом файле — readOnly', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    const info = buildProviderPermissionInfo(targetFor(filePath));
    expect(info.kind).toBe('opencode');
    if (info.kind !== 'opencode') throw new Error('ожидалась opencode-модель');
    expect(info.format).toBe('opencode-json');
    expect(info.levels).toEqual(['allow', 'deny', 'ask']);
    expect(info.tools).toEqual(['edit', 'bash', 'webfetch']);
    expect(info.patternTools).toEqual(['bash']);
    expect(info.entries).toHaveLength(3);
    expect(info.readOnly).toBe(false);

    writeFileSync(filePath, '{ oops');
    const brokenInfo = buildProviderPermissionInfo(targetFor(filePath));
    expect(brokenInfo.readOnly).toBe(true);
    expect(brokenInfo.error).toBeTruthy();
  });
});
