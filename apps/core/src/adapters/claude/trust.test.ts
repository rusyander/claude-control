import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeGlobalConfigFiles, claudeTrustMark } from './trust.ts';

/**
 * Запись доверия Claude Code (F-86): ядро читает отметку CLI к ИСХОДНОМУ репозиторию в его
 * глобальном конфиге и никогда её не пишет. Каждый случай — свой одноразовый дом.
 */

function stand(): { home: string; source: string; copy: string; pin: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adp-ctrust-')));
  const home = join(root, 'home');
  const source = join(root, 'repo');
  const copy = join(root, 'copies', 'repo-task');
  for (const dir of [home, source, copy]) mkdirSync(dir, { recursive: true });
  return { home, source, copy, pin: { HOME: home, USERPROFILE: home } };
}

const accepted = (...paths: string[]) =>
  JSON.stringify({
    projects: Object.fromEntries(paths.map((p) => [p, { hasTrustDialogAccepted: true }])),
  });

describe('claude trust record — F-86 the CLI mark of the source repo', () => {
  it('F-86: no global config → no mark (trusted false), not unknown', async () => {
    const s = stand();
    const read = await claudeTrustMark(s.source, s.pin);
    expect(read).toMatchObject({ trusted: false });
    expect(JSON.stringify(read)).toContain('is absent');
  });

  it('F-86: the accepted source repo is trusted; a mark on the copy alone does not trust the source', async () => {
    const s = stand();
    writeFileSync(join(s.home, '.claude.json'), accepted(s.source));
    expect(await claudeTrustMark(s.source, s.pin)).toEqual({ trusted: true });

    const only = stand();
    writeFileSync(join(only.home, '.claude.json'), accepted(only.copy));
    expect(await claudeTrustMark(only.source, only.pin)).toMatchObject({ trusted: false });
  });

  it('F-86: only hasTrustDialogAccepted === true counts; a relative key is not a CLI path', async () => {
    const s = stand();
    writeFileSync(
      join(s.home, '.claude.json'),
      JSON.stringify({
        projects: {
          [s.source]: { hasTrustDialogAccepted: 'true' },
          repo: { hasTrustDialogAccepted: true },
        },
      }),
    );
    expect(await claudeTrustMark(s.source, s.pin)).toMatchObject({ trusted: false });
  });

  it.runIf(process.platform === 'win32')(
    'F-86: the CLI key spelling (forward slashes, other case) names the same Windows path',
    async () => {
      const s = stand();
      writeFileSync(
        join(s.home, '.claude.json'),
        accepted(s.source.replaceAll('\\', '/').toUpperCase()),
      );
      expect(await claudeTrustMark(s.source, s.pin)).toEqual({ trusted: true });
    },
  );

  it('F-86: CLAUDE_CONFIG_DIR moves the record; a non-empty legacy .config.json wins, an empty one does not', async () => {
    const s = stand();
    const config = join(s.home, 'cfg');
    mkdirSync(config);
    const pin = { ...s.pin, CLAUDE_CONFIG_DIR: config };
    expect(claudeGlobalConfigFiles(pin)).toEqual({
      legacy: join(config, '.config.json'),
      main: join(config, '.claude.json'),
    });
    // Отметка в доме не считается — CLI с этим окружением читает каталог конфигурации.
    writeFileSync(join(s.home, '.claude.json'), accepted(s.source));
    expect(await claudeTrustMark(s.source, pin)).toMatchObject({ trusted: false });

    writeFileSync(join(config, '.claude.json'), accepted(s.source));
    writeFileSync(join(config, '.config.json'), '');
    expect(await claudeTrustMark(s.source, pin)).toEqual({ trusted: true });
    writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: {} }));
    expect(await claudeTrustMark(s.source, pin)).toMatchObject({ trusted: false });
  });

  it('F-86: CLAUDE_CODE_IGNORE_PERSISTED_TRUST set → the record is not believed; a falsy value keeps it', async () => {
    const s = stand();
    writeFileSync(join(s.home, '.claude.json'), accepted(s.source));
    expect(
      await claudeTrustMark(s.source, { ...s.pin, CLAUDE_CODE_IGNORE_PERSISTED_TRUST: '1' }),
    ).toMatchObject({ trusted: false });
    expect(
      await claudeTrustMark(s.source, { ...s.pin, CLAUDE_CODE_IGNORE_PERSISTED_TRUST: 'false' }),
    ).toEqual({ trusted: true });
  });

  it('F-86: a record that does not parse, or projects of the wrong shape → unknown (F25)', async () => {
    const s = stand();
    writeFileSync(join(s.home, '.claude.json'), '{ broken');
    expect(await claudeTrustMark(s.source, s.pin)).toHaveProperty('unknown');
    writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ projects: [] }));
    expect(await claudeTrustMark(s.source, s.pin)).toHaveProperty('unknown');
  });
});
