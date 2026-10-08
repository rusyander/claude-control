import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  readClaudeCredentials,
  validatePanelCredentials,
  savePanelCredentials,
  removePanelCredentials,
  panelCredentialsPath,
} from './credentials.ts';

/**
 * Разница между системами здесь и живёт, поэтому проверяется то, что можно
 * проверить на любой машине: чтение файла и внятность отказа. Связка ключей
 * macOS проверяется только на маке — подменять `security` заглушкой смысла нет,
 * это проверяло бы заглушку, а не поведение.
 */
describe('readClaudeCredentials', () => {
  const dirs: string[] = [];

  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('читает файл, когда он есть — на любой системе', () => {
    const dir = makeDir();
    const payload = '{"claudeAiOauth":{"accessToken":"test"}}';
    writeFileSync(join(dir, '.credentials.json'), payload, 'utf8');

    const result = readClaudeCredentials(dir);

    expect(result.source).toBe('file');
    expect(result.content).toBe(payload);
  });

  it('без файла на Windows и Linux объясняет, что делать', () => {
    const result = readClaudeCredentials(makeDir());

    if (process.platform === 'darwin') {
      // На маке источник другой — здесь проверяем только, что вызов не падает.
      expect(['keychain', 'none']).toContain(result.source);
      return;
    }

    expect(result.source).toBe('none');
    expect(result.reason).toMatch(/claude/i);
  });

  it.runIf(process.platform === 'darwin')(
    'на macOS обращается к связке ключей и не падает без записи',
    () => {
      const result = readClaudeCredentials(makeDir());

      expect(['keychain', 'none']).toContain(result.source);
      if (result.source === 'none') expect(result.reason).toMatch(/связке ключей/i);
    },
  );

  it.runIf(process.platform !== 'win32')('нечитаемый файл не роняет вызов', () => {
    const dir = makeDir();
    const path = join(dir, '.credentials.json');
    writeFileSync(path, '{}', 'utf8');
    chmodSync(path, 0o000);

    const result = readClaudeCredentials(dir);

    expect(['file', 'none']).toContain(result.source);
  });
});

/**
 * Заданное руками. Тесты трогают настоящий файл панели в домашнем каталоге,
 * поэтому каждый за собой убирает — и восстанавливает то, что там лежало.
 */
describe('доступ, заданный вручную', () => {
  const path = panelCredentialsPath();
  let saved: string | undefined;

  const backup = (): void => {
    saved = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };

  afterEach(() => {
    removePanelCredentials();
    if (saved !== undefined) savePanelCredentials(saved);
    saved = undefined;
  });

  it('перебивает штатный источник — ради этого он и нужен', () => {
    backup();
    const dir = mkdtempSync(join(tmpdir(), 'creds-'));
    writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"из файла"}}');

    savePanelCredentials(JSON.stringify({ apiKey: 'sk-ant-api03-вручную' }));
    const result = readClaudeCredentials(dir);

    expect(result.source).toBe('panel');
    expect(result.apiKey).toBe('sk-ant-api03-вручную');
    rmSync(dir, { recursive: true, force: true });
  });

  it('поле readFrom читает указанный файл', () => {
    backup();
    const dir = mkdtempSync(join(tmpdir(), 'creds-'));
    const external = join(dir, 'мой-токен.json');
    writeFileSync(external, '{"claudeAiOauth":{"accessToken":"снаружи"}}', 'utf8');

    savePanelCredentials(JSON.stringify({ readFrom: external }));
    const result = readClaudeCredentials(mkdtempSync(join(tmpdir(), 'empty-')));

    expect(result.source).toBe('panel');
    expect(result.content).toContain('снаружи');
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'файл с секретом создаётся сразу с правами 600, а каталог — 700',
    () => {
      backup();
      savePanelCredentials(JSON.stringify({ apiKey: 'sk-ant-api03-права' }));

      // Права проверяются у готового файла, но важно, что они заданы самим
      // созданием: между записью и chmod файл успевал полежать открытым.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== 'win32')('перезапись не наследует широкие права', () => {
    backup();
    savePanelCredentials(JSON.stringify({ apiKey: 'первый' }));
    chmodSync(path, 0o644);

    savePanelCredentials(JSON.stringify({ apiKey: 'второй' }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('проверка ввода отсеивает мусор и объясняет причину', () => {
    expect(validatePanelCredentials('')).toMatchObject({ ok: false });
    expect(validatePanelCredentials('{не json')).toMatchObject({ ok: false });
    expect(validatePanelCredentials('{"foo":1}')).toMatchObject({ ok: false });
    expect(validatePanelCredentials('{"claudeAiOauth":{}}')).toMatchObject({ ok: false });
    expect(validatePanelCredentials('{"readFrom":"/нет/такого"}')).toMatchObject({ ok: false });

    expect(validatePanelCredentials('{"apiKey":"sk-ant-api03-x"}')).toEqual({ ok: true });
    expect(validatePanelCredentials('{"claudeAiOauth":{"accessToken":"x"}}')).toEqual({ ok: true });
  });
});
