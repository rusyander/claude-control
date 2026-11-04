import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeFolderTrust } from './folder-trust.ts';

/**
 * Доверие Claude Code к папке для карточки «Локальный слой» (s10 G14 p7): та же запись и тот же
 * порядок, что у ядра (`adapters/claude/trust.ts`), — человек узнаёт об отказе до хода.
 */

function stand(): { legacy: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'folder-trust-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return { legacy: join(root, '.claude', '.config.json'), main: join(root, '.claude.json') };
}

const write = (file: string, projects: unknown): void =>
  writeFileSync(file, JSON.stringify({ projects }), 'utf8');

describe('claudeFolderTrust (s10 G14 p7)', () => {
  it('trusted only by an accepted trust entry for this very folder; slashes and Windows case do not matter', () => {
    const files = stand();
    write(files.main, {
      'C:/work/app': { hasTrustDialogAccepted: true },
      'C:/work/other': { hasTrustDialogAccepted: false },
    });
    expect(claudeFolderTrust('c:\\work\\app', files, {})).toBe('trusted');
    expect(claudeFolderTrust('C:\\work\\other', files, {})).toBe('untrusted');
    expect(claudeFolderTrust('C:\\work\\app\\sub', files, {})).toBe('untrusted');
  });

  it('no config file or no projects → untrusted; unreadable shape → unknown (the card stays silent)', () => {
    const files = stand();
    expect(claudeFolderTrust('/w/app', files, {})).toBe('untrusted');
    writeFileSync(files.main, '{}', 'utf8');
    expect(claudeFolderTrust('/w/app', files, {})).toBe('untrusted');
    writeFileSync(files.main, 'not json', 'utf8');
    expect(claudeFolderTrust('/w/app', files, {})).toBe('unknown');
    writeFileSync(files.main, JSON.stringify({ projects: [] }), 'utf8');
    expect(claudeFolderTrust('/w/app', files, {})).toBe('unknown');
  });

  it('a non-empty legacy .config.json wins over .claude.json, as the CLI reads it', () => {
    const files = stand();
    write(files.main, { '/w/app': { hasTrustDialogAccepted: true } });
    write(files.legacy, {});
    expect(claudeFolderTrust('/w/app', files, {})).toBe('untrusted');
    writeFileSync(files.legacy, '', 'utf8');
    expect(claudeFolderTrust('/w/app', files, {})).toBe('trusted');
  });

  it('CLAUDE_CODE_IGNORE_PERSISTED_TRUST set → untrusted whatever the file says; a falsy value is ignored', () => {
    const files = stand();
    write(files.main, { '/w/app': { hasTrustDialogAccepted: true } });
    expect(claudeFolderTrust('/w/app', files, { CLAUDE_CODE_IGNORE_PERSISTED_TRUST: '1' })).toBe(
      'untrusted',
    );
    expect(
      claudeFolderTrust('/w/app', files, { CLAUDE_CODE_IGNORE_PERSISTED_TRUST: 'false' }),
    ).toBe('trusted');
  });
});
