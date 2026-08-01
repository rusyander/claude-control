import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeEntry } from '../lib/safe-io.ts';
import {
  previewProviderWrite,
  SectionUnsupportedError,
  InvalidDraftError,
} from './provider-preview.ts';

/**
 * Предпросмотр записи. Доказываем три вещи: дифф отражает НАСТОЯЩИЙ результат
 * адаптера, файл пользователя при этом не меняется, а отказы те же, что у
 * записи (иначе предпросмотр был бы добрее её и пропускал бы мусор).
 */
const CONFIG = `approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.demo]
command = "node"
args = ["server.js"]
`;

const store = (provider: string) => ({
  getSettings: () => ({ provider, claudeDirOverride: '' }),
});

describe('previewProviderWrite', () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-preview-test-'));
    previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    writeFileSync(join(home, 'config.toml'), CONFIG);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    removeEntry(home);
  });

  it('новый MCP-сервер: дифф показывает добавление, файл не тронут', () => {
    const result = previewProviderWrite(store('codex'), {
      section: 'mcp',
      action: 'upsert',
      draft: { name: 'fresh', transport: 'stdio', command: 'npx', args: ['pkg'] },
    });

    expect(result.exists).toBe(true);
    expect(result.unchanged).toBe(false);
    expect(result.added).toBeGreaterThan(0);
    expect(
      result.lines.some(
        (line: { kind: string; text: string }) =>
          line.kind === 'add' && line.text.includes('fresh'),
      ),
    ).toBe(true);
    // Всё, что ВНЕ региона mcp_servers, осталось контекстом — адаптер правит
    // только свой участок файла.
    expect(
      result.lines.some(
        (line: { kind: string; text: string }) =>
          line.kind !== 'ctx' && line.text.includes('approval_policy'),
      ),
    ).toBe(false);
    // А вот внутри региона сериализатор переписывает и соседнюю запись
    // (`["a"]` → `[ "a" ]`): смысл тот же, байты другие. Ровно ради таких
    // сюрпризов предпросмотр и нужен — тест фиксирует их как ожидаемые.
    expect(result.lines.some((line: { kind: string }) => line.kind === 'del')).toBe(true);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(CONFIG);
    expect(readdirSync(home)).toEqual(['config.toml']);
  });

  it('запись тех же значений видна как «ничего не изменится»', () => {
    const result = previewProviderWrite(store('codex'), {
      section: 'permissions',
      draft: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
    });

    expect(result.unchanged).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('удаление сервера показывает удаление его строк', () => {
    const result = previewProviderWrite(store('codex'), {
      section: 'mcp',
      action: 'delete',
      serverId: 'demo',
    });

    expect(result.removed).toBeGreaterThan(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(CONFIG);
  });

  it('черновик-мусор отвергается так же, как на записи', () => {
    expect(() =>
      previewProviderWrite(store('codex'), { section: 'mcp', draft: { name: '' } }),
    ).toThrow(InvalidDraftError);
  });

  it('раздел, которого у провайдера нет, — отказ (fail-closed)', () => {
    expect(() => previewProviderWrite(store('claude'), { section: 'mcp', draft: {} })).toThrow(
      SectionUnsupportedError,
    );
  });
});
