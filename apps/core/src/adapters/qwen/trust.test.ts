import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qwenTrustDecision, qwenTrustFile, qwenTrustMark, QWEN_TRUST_LEVELS } from './trust.ts';

/**
 * Запись доверия Qwen Code к папкам (F-86, 0.24.3): ядро решает по ней так же, как CLI, — самое
 * глубокое совпавшее правило, при равной глубине недоверие; запись только читается.
 */

const { folder, parent, never } = QWEN_TRUST_LEVELS;

function stand(): { home: string; source: string; pin: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adp-qtrust-')));
  const home = join(root, 'home');
  const source = join(root, 'work', 'repo');
  for (const dir of [join(home, '.qwen'), source]) mkdirSync(dir, { recursive: true });
  return { home, source, pin: { HOME: home, USERPROFILE: home } };
}

describe('qwen trust record — F-86 the CLI mark of the source repo', () => {
  it('F-86: the record file follows QWEN_CODE_TRUSTED_FOLDERS_PATH, then QWEN_HOME, then ~/.qwen', () => {
    const s = stand();
    expect(qwenTrustFile(s.pin)).toBe(join(s.home, '.qwen', 'trustedFolders.json'));
    const qhome = join(s.home, 'qh');
    expect(qwenTrustFile({ ...s.pin, QWEN_HOME: qhome })).toBe(join(qhome, 'trustedFolders.json'));
    const direct = join(s.home, 'direct.json');
    expect(
      qwenTrustFile({ ...s.pin, QWEN_HOME: qhome, QWEN_CODE_TRUSTED_FOLDERS_PATH: direct }),
    ).toBe(direct);
    expect(qwenTrustFile({ ...s.pin, QWEN_CODE_TRUSTED_FOLDERS_PATH: 'rel.json' })).toBeNull();
    // `~` CLI раскрывает от дома; относительный дом он достроит от своего cwd — ядру он неизвестен.
    expect(qwenTrustFile({ ...s.pin, QWEN_HOME: '~/q' })).toBe(
      join(s.home, 'q', 'trustedFolders.json'),
    );
    expect(qwenTrustFile({ ...s.pin, QWEN_HOME: 'rel-home' })).toBeNull();
  });

  it('F-86: TRUST_FOLDER covers the folder and inside; TRUST_PARENT covers the parent; the deepest rule wins, a tie is untrusted', () => {
    const s = stand();
    const work = dirname(s.source);
    expect(qwenTrustDecision({ [s.source]: folder }, s.source)).toBe(true);
    expect(qwenTrustDecision({ [work]: folder }, s.source)).toBe(true);
    expect(qwenTrustDecision({ [join(work, 'other')]: parent }, s.source)).toBe(true);
    expect(qwenTrustDecision({ [join(s.source, 'sub')]: folder }, s.source)).toBeUndefined();
    expect(qwenTrustDecision({ [work]: folder, [s.source]: never }, s.source)).toBe(false);
    expect(qwenTrustDecision({ [work]: never, [s.source]: folder }, s.source)).toBe(true);
    expect(qwenTrustDecision({ [s.source]: folder, [join(s.source, 'x')]: parent }, s.source)).toBe(
      true,
    );
    // Равная глубина: TRUST_FOLDER на пути и TRUST_PARENT на его ребёнке против DO_NOT_TRUST.
    expect(qwenTrustDecision({ [join(s.source, 'x')]: parent, [s.source]: never }, s.source)).toBe(
      false,
    );
    expect(qwenTrustDecision({ repo: folder, [s.source]: 'MAYBE' }, s.source)).toBeUndefined();
  });

  it('F-86: absent record → no mark; trusted source → trusted; untrusted rule → detail names it', async () => {
    const s = stand();
    expect(await qwenTrustMark(s.source, s.pin)).toMatchObject({ trusted: false });
    const file = join(s.home, '.qwen', 'trustedFolders.json');
    writeFileSync(file, JSON.stringify({ [s.source]: folder }));
    expect(await qwenTrustMark(s.source, s.pin)).toEqual({ trusted: true });
    writeFileSync(file, JSON.stringify({ [s.source]: never }));
    const read = await qwenTrustMark(s.source, s.pin);
    expect(read).toMatchObject({ trusted: false });
    expect(JSON.stringify(read)).toContain('untrusted');
  });

  it('F-86: JSONC comments, a non-object or a relative override → unknown (F25), never trusted', async () => {
    const s = stand();
    const file = join(s.home, '.qwen', 'trustedFolders.json');
    writeFileSync(file, `// note\n${JSON.stringify({ [s.source]: folder })}`);
    expect(await qwenTrustMark(s.source, s.pin)).toHaveProperty('unknown');
    writeFileSync(file, '[]');
    expect(await qwenTrustMark(s.source, s.pin)).toHaveProperty('unknown');
    expect(
      await qwenTrustMark(s.source, { ...s.pin, QWEN_CODE_TRUSTED_FOLDERS_PATH: 'x.json' }),
    ).toHaveProperty('unknown');
  });
});
