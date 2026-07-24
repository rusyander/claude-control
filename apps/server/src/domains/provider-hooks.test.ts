import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { BOM_CHAR } from '../lib/text-form.ts';
import { UnrecognizedFormatError } from '../lib/codex-toml.ts';
import {
  readProviderHooksInfo,
  saveProviderHooks,
  parseProviderHooksDraft,
  type ProviderHooksTarget,
} from './provider-hooks.ts';

/**
 * OPENCODE-3: хуки в `opencode.json` — ключ `experimental.hook`.
 *
 * Проверяем главное: оба задокументированных события читаются и пишутся, правится
 * ТОЛЬКО этот ключ (прочие ключи файла, прочие ключи `experimental` и незнакомые
 * события целы), кривой черновик не проходит валидацию, битый JSON не
 * перезаписывается, пустой результат удаляет ключ, а не пишет `{}`.
 *
 * Файлы — только во временных каталогах, домашний каталог не затрагивается.
 */
describe('OpenCode opencode.json: хуки в ключе experimental.hook', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderHooksTarget => ({
    provider: getProvider('opencode'),
    format: 'opencode-json',
    scope: 'global',
    filePath,
  });

  const save = (filePath: string, body: unknown): string | undefined => {
    const draft = parseProviderHooksDraft(body);
    if (!draft) throw new Error('черновик не прошёл разбор');
    return saveProviderHooks(targetFor(filePath), draft, backupDir);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-opencode-hooks-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Живой opencode.json: схема, модель, MCP, права и оба события хуков. */
  const CONFIG = JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4',
      mcp: { probe: { type: 'local', command: ['node', 'x.js'] } },
      permission: { edit: 'deny' },
      experimental: {
        // Чужой ключ `experimental` — панель его не ведёт и обязана сохранить.
        policies: [{ effect: 'deny', action: 'provider.use', resource: 'openai' }],
        hook: {
          file_edited: {
            '*.ts': [
              { command: ['prettier', '--write'], environment: { NODE_ENV: 'development' } },
            ],
            '*.md': [{ command: ['markdownlint'] }],
          },
          session_completed: [{ command: ['notify-send', 'Session completed!'] }],
        },
      },
    },
    null,
    2,
  );

  // --- Чтение ----------------------------------------------------------------

  it('читает оба события: карту шаблонов file_edited и список session_completed', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    const info = readProviderHooksInfo(targetFor(filePath));
    expect(info.present).toBe(true);
    expect(info.readOnly).toBe(false);
    // Порядок файла сохраняется — пользователь видит свой конфиг, а не пересортицу.
    expect(info.fileEdited).toEqual([
      {
        pattern: '*.ts',
        actions: [
          {
            command: ['prettier', '--write'],
            environment: [{ key: 'NODE_ENV', value: 'development' }],
          },
        ],
      },
      { pattern: '*.md', actions: [{ command: ['markdownlint'] }] },
    ]);
    expect(info.sessionCompleted).toEqual([{ command: ['notify-send', 'Session completed!'] }]);
    // Чужой ключ `experimental` показан только для чтения.
    expect(info.preservedExperimental).toEqual([
      { key: 'policies', value: expect.stringContaining('provider.use') },
    ]);
    expect(info.preservedEvents).toEqual([]);
  });

  it('нет файла или нет ключа — хуков нет, файл НЕ создаётся', () => {
    const filePath = join(root, 'missing.json');
    const info = readProviderHooksInfo(targetFor(filePath));
    expect(info.present).toBe(false);
    expect(info.fileEdited).toEqual([]);
    expect(info.sessionCompleted).toEqual([]);
    expect(info.readOnly).toBe(false);
    expect(existsSync(filePath)).toBe(false);

    const other = join(root, 'other.json');
    writeFileSync(other, JSON.stringify({ model: 'x' }));
    expect(readProviderHooksInfo(targetFor(other)).present).toBe(false);
  });

  it('незнакомое событие и непонятая форма события уходят в «сохранённые»', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        experimental: {
          hook: {
            // Незнакомое панели событие.
            tool_called: [{ command: ['echo', 'hi'] }],
            // Знакомое событие, но форма чужая: `command` строкой, а не argv.
            session_completed: [{ command: 'notify-send hi' }],
            // Знакомое событие, но у действия чужое поле — переписывать нельзя.
            file_edited: { '*.ts': [{ command: ['x'], timeout: 5 }] },
          },
        },
      }),
    );

    const info = readProviderHooksInfo(targetFor(filePath));
    expect(info.fileEdited).toEqual([]);
    expect(info.sessionCompleted).toEqual([]);
    expect(info.preservedEvents.map((entry) => entry.key).sort()).toEqual([
      'file_edited',
      'session_completed',
      'tool_called',
    ]);
  });

  it('битый JSON и не-объект experimental/hook → раздел только для чтения', () => {
    const broken = join(root, 'broken.json');
    writeFileSync(broken, '{ "experimental": ');
    const brokenInfo = readProviderHooksInfo(targetFor(broken));
    expect(brokenInfo.readOnly).toBe(true);
    expect(brokenInfo.error).toBeTruthy();

    const scalar = join(root, 'scalar.json');
    writeFileSync(scalar, JSON.stringify({ experimental: 'yes' }));
    expect(readProviderHooksInfo(targetFor(scalar)).readOnly).toBe(true);

    const hookArray = join(root, 'hook-array.json');
    writeFileSync(hookArray, JSON.stringify({ experimental: { hook: [] } }));
    expect(readProviderHooksInfo(targetFor(hookArray)).readOnly).toBe(true);
  });

  // --- Валидация черновика ----------------------------------------------------

  it('отклоняет кривые черновики ДО записи (400)', () => {
    const bad: unknown[] = [
      // не объект / нет полей
      null,
      [],
      {},
      { fileEdited: [] },
      { fileEdited: {}, sessionCompleted: [] },
      { fileEdited: [], sessionCompleted: {} },
      // command не массив
      { fileEdited: [], sessionCompleted: [{ command: 'prettier --write' }] },
      // command пустой
      { fileEdited: [], sessionCompleted: [{ command: [] }] },
      // элемент argv не строка
      { fileEdited: [], sessionCompleted: [{ command: ['x', 7] }] },
      // пустой аргумент
      { fileEdited: [], sessionCompleted: [{ command: ['x', ''] }] },
      // environment не массив пар
      { fileEdited: [], sessionCompleted: [{ command: ['x'], environment: { A: 'b' } }] },
      // имя переменной пустое / с «=»
      {
        fileEdited: [],
        sessionCompleted: [{ command: ['x'], environment: [{ key: '', value: 'b' }] }],
      },
      {
        fileEdited: [],
        sessionCompleted: [{ command: ['x'], environment: [{ key: 'A=B', value: 'b' }] }],
      },
      // повтор имени переменной — в JSON одна из пар молча пропала бы
      {
        fileEdited: [],
        sessionCompleted: [
          {
            command: ['x'],
            environment: [
              { key: 'A', value: '1' },
              { key: 'A', value: '2' },
            ],
          },
        ],
      },
      // шаблон пустой
      { fileEdited: [{ pattern: '  ', actions: [{ command: ['x'] }] }], sessionCompleted: [] },
      // шаблон повторяется — ключи объекта схлопнулись бы
      {
        fileEdited: [
          { pattern: '*.ts', actions: [{ command: ['a'] }] },
          { pattern: '*.ts', actions: [{ command: ['b'] }] },
        ],
        sessionCompleted: [],
      },
      // шаблон без действий — в файле это пустой ключ без смысла
      { fileEdited: [{ pattern: '*.ts', actions: [] }], sessionCompleted: [] },
    ];

    for (const body of bad) {
      expect(parseProviderHooksDraft(body), JSON.stringify(body)).toBeUndefined();
    }
  });

  it('принимает корректный черновик обоих событий', () => {
    expect(
      parseProviderHooksDraft({
        fileEdited: [
          {
            pattern: '*.ts',
            actions: [
              { command: ['prettier', '--write'], environment: [{ key: 'A', value: '1' }] },
            ],
          },
        ],
        sessionCompleted: [{ command: ['notify-send', 'done'] }],
      }),
    ).toEqual({
      fileEdited: [
        {
          pattern: '*.ts',
          actions: [{ command: ['prettier', '--write'], environment: [{ key: 'A', value: '1' }] }],
        },
      ],
      sessionCompleted: [{ command: ['notify-send', 'done'] }],
    });
  });

  // --- Запись -----------------------------------------------------------------

  it('round-trip: пишет оба события, прочие ключи файла и experimental целы', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(filePath, CONFIG);

    const backupPath = save(filePath, {
      fileEdited: [
        {
          pattern: '*.tsx',
          actions: [
            { command: ['eslint', '--fix'], environment: [{ key: 'CI', value: 'true' }] },
            { command: ['prettier', '--write'] },
          ],
        },
      ],
      sessionCompleted: [{ command: ['say', 'готово'] }],
    });
    expect(backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    // Чужие ключи файла байт-в-байт.
    expect(written.$schema).toBe('https://opencode.ai/config.json');
    expect(written.model).toBe('anthropic/claude-sonnet-4');
    expect(written.mcp).toEqual({ probe: { type: 'local', command: ['node', 'x.js'] } });
    expect(written.permission).toEqual({ edit: 'deny' });
    // Чужой ключ `experimental` цел.
    const experimental = written.experimental as Record<string, unknown>;
    expect(experimental.policies).toEqual([
      { effect: 'deny', action: 'provider.use', resource: 'openai' },
    ]);
    // Хуки — ровно из черновика (в файле command это МАССИВ, а не строка).
    expect(experimental.hook).toEqual({
      file_edited: {
        '*.tsx': [
          { command: ['eslint', '--fix'], environment: { CI: 'true' } },
          { command: ['prettier', '--write'] },
        ],
      },
      session_completed: [{ command: ['say', 'готово'] }],
    });

    // Перечитывание возвращает ровно то, что записали.
    const info = readProviderHooksInfo(targetFor(filePath));
    expect(info.fileEdited).toEqual([
      {
        pattern: '*.tsx',
        actions: [
          { command: ['eslint', '--fix'], environment: [{ key: 'CI', value: 'true' }] },
          { command: ['prettier', '--write'] },
        ],
      },
    ]);
    expect(info.sessionCompleted).toEqual([{ command: ['say', 'готово'] }]);
  });

  it('пустой черновик УДАЛЯЕТ hook и experimental, если больше ничего не осталось', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        model: 'x',
        experimental: { hook: { session_completed: [{ command: ['a'] }] } },
      }),
    );

    save(filePath, { fileEdited: [], sessionCompleted: [] });

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(written.model).toBe('x');
    // Ни `experimental: {}`, ни `hook: {}` в файле появиться не должно.
    expect('experimental' in written).toBe(false);
    expect(readFileSync(filePath, 'utf8')).not.toContain('{}');
  });

  it('пустое событие удаляет только свой ключ, чужой ключ experimental остаётся', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        experimental: {
          batch_tool: true,
          hook: {
            file_edited: { '*.ts': [{ command: ['a'] }] },
            session_completed: [{ command: ['b'] }],
          },
        },
      }),
    );

    save(filePath, { fileEdited: [], sessionCompleted: [{ command: ['b'] }] });

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const experimental = written.experimental as Record<string, unknown>;
    expect(experimental.batch_tool).toBe(true);
    expect(experimental.hook).toEqual({ session_completed: [{ command: ['b'] }] });
  });

  it('незнакомые события переживают запись и не перезаписываются черновиком', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        experimental: {
          hook: {
            tool_called: [{ command: ['echo'] }],
            session_completed: [{ command: ['old'] }],
          },
        },
      }),
    );

    save(filePath, { fileEdited: [], sessionCompleted: [{ command: ['new'] }] });

    const experimental = (
      JSON.parse(readFileSync(filePath, 'utf8')) as { experimental: Record<string, unknown> }
    ).experimental;
    expect(experimental.hook).toEqual({
      tool_called: [{ command: ['echo'] }],
      session_completed: [{ command: ['new'] }],
    });
  });

  it('черновик, называющий НЕразобранное событие, отклоняется (422), файл цел', () => {
    const filePath = join(root, 'opencode.json');
    // `file_edited` непонятой формы: действие с чужим полем.
    const before = JSON.stringify({
      experimental: { hook: { file_edited: { '*.ts': [{ command: ['x'], timeout: 5 }] } } },
    });
    writeFileSync(filePath, before);

    expect(() =>
      save(filePath, {
        fileEdited: [{ pattern: '*.ts', actions: [{ command: ['y'] }] }],
        sessionCompleted: [],
      }),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('битый JSON не переписывается и копия не создаётся', () => {
    const filePath = join(root, 'broken.json');
    const before = '{ "experimental": ';
    writeFileSync(filePath, before);

    expect(() => save(filePath, { fileEdited: [], sessionCompleted: [] })).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('BOM и CRLF сохраняются', () => {
    const filePath = join(root, 'opencode.json');
    writeFileSync(
      filePath,
      `${BOM_CHAR}${JSON.stringify({ model: 'x' }, null, 2)}`.replace(/\n/g, '\r\n'),
    );

    save(filePath, { fileEdited: [], sessionCompleted: [{ command: ['a'] }] });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw.startsWith(BOM_CHAR)).toBe(true);
    expect(raw).toContain('\r\n');
    expect(readProviderHooksInfo(targetFor(filePath)).sessionCompleted).toEqual([
      { command: ['a'] },
    ]);
  });

  it('файла не было — создаётся только с ключом experimental.hook', () => {
    const filePath = join(root, 'fresh.json');
    save(filePath, { fileEdited: [], sessionCompleted: [{ command: ['a'] }] });

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      experimental: { hook: { session_completed: [{ command: ['a'] }] } },
    });
  });
});
