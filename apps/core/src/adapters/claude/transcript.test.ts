import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeOwnsTranscript } from './transcript.ts';

/**
 * Разговор Claude Code, начатый не ядром, — этого корня (этап 10, F2): доказывает сам транскрипт
 * в хранилище CLI (`CLAUDE_CONFIG_DIR/projects/<любая папка>/<id>.jsonl`), строки этого id
 * называют папку. Имя папки проекта не разбирается; путь корня сравнивается платформой.
 */

const ID = '0d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';

function store(): { pin: Record<string, string>; projects: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'claude-owns-'));
  const config = join(base, 'config');
  const root = join(base, 'proj');
  mkdirSync(root, { recursive: true });
  return { pin: { CLAUDE_CONFIG_DIR: config }, projects: join(config, 'projects'), root };
}

function put(projects: string, folder: string, name: string, rows: unknown[]): void {
  mkdirSync(join(projects, folder), { recursive: true });
  writeFileSync(
    join(projects, folder, `${name}.jsonl`),
    `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`,
  );
}

describe('claude ownsTranscript: the transcript itself names its root', () => {
  it('a transcript of this root in any project folder is owned; trailing slash and case of the path do not matter', () => {
    const s = store();
    put(s.projects, 'whatever-name', ID, [
      'not json',
      { type: 'mode', sessionId: ID },
      { type: 'user', cwd: `${s.root}${process.platform === 'win32' ? '\\' : '/'}`, sessionId: ID },
    ]);
    expect(claudeOwnsTranscript(s.pin, s.root, ID)).toBe(true);
    if (process.platform === 'win32') {
      expect(claudeOwnsTranscript(s.pin, s.root.toUpperCase(), ID)).toBe(true);
    }
  });

  it('no store, no file, another root, rows of another id: not owned', () => {
    const s = store();
    expect(claudeOwnsTranscript(s.pin, s.root, ID)).toBe(false);
    put(s.projects, 'a', 'ffffffff-0000-4000-8000-000000000000', [
      { type: 'user', cwd: s.root, sessionId: 'ffffffff-0000-4000-8000-000000000000' },
    ]);
    expect(claudeOwnsTranscript(s.pin, s.root, ID)).toBe(false);
    put(s.projects, 'b', ID, [
      { type: 'user', cwd: join(s.root, '..', 'elsewhere'), sessionId: ID },
    ]);
    expect(claudeOwnsTranscript(s.pin, s.root, ID)).toBe(false);
    put(s.projects, 'b', ID, [{ type: 'user', cwd: s.root, sessionId: 'someone-else' }]);
    expect(claudeOwnsTranscript(s.pin, s.root, ID)).toBe(false);
  });

  it('one of two same-named transcripts naming this root is enough', () => {
    const s = store();
    put(s.projects, 'a', ID, [{ type: 'user', cwd: join(s.root, 'sub'), sessionId: ID }]);
    put(s.projects, 'b', ID, [{ type: 'user', cwd: s.root, sessionId: ID }]);
    expect(claudeOwnsTranscript(s.pin, s.root, ID)).toBe(true);
  });

  it('an id that is not a UUID is never a file name: path tricks and junk are not owned', () => {
    const s = store();
    put(s.projects, 'a', ID, [{ type: 'user', cwd: s.root, sessionId: ID }]);
    for (const bad of [`../a/${ID}`, `${ID}.jsonl`, '', 'x', ID.toUpperCase().replace(/-/g, '')]) {
      expect(claudeOwnsTranscript(s.pin, s.root, bad)).toBe(false);
    }
    // Файлы, чьи строки называют сам этот id своим: без проверки формы они бы «доказали» корень.
    put(s.projects, 'a', 'x', [{ type: 'user', cwd: s.root, sessionId: 'x' }]);
    expect(claudeOwnsTranscript(s.pin, s.root, 'x')).toBe(false);
    const sneaky = `../b/${ID}`;
    put(s.projects, 'b', ID, [{ type: 'user', cwd: s.root, sessionId: sneaky }]);
    expect(claudeOwnsTranscript(s.pin, s.root, sneaky)).toBe(false);
  });
});
