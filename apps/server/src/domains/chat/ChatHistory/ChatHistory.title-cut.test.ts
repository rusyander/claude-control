import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maskSecretsInText, SECRET_MASK } from '../../../lib/secret-mask/secret-mask.ts';
import { readChats } from './ChatHistory.ts';

/**
 * Ревью U0, m2 (28.09.2026): заголовок из первой реплики резался на 70 символах ДО
 * маски. Ключ, который пересекает 70-й символ, оставлял обрезок короче порогов
 * детектора (непрозрачный — от 24, `sk-` — +16), и маска модели его уже не узнавала.
 */
const KEY = ['Qz7Lm2Xc9', 'Vb4Nd8Rt1', 'Wy6Kp3Hs5Jf0'].join('');

describe('chat title from the first message: a key cut by the 70-char limit', () => {
  let projectsDir: string;
  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-title-'));
  });
  afterEach(() => rmSync(projectsDir, { recursive: true, force: true }));

  const titleOf = (prompt: string): string => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const line = {
      type: 'user',
      uuid: 'u1',
      cwd: 'C:/work/app',
      timestamp: '2026-09-28T10:00:00.000Z',
      message: { role: 'user', content: prompt },
    };
    writeFileSync(join(dir, 's1.jsonl'), `${JSON.stringify(line)}\n`);
    return readChats(projectsDir)[0]!.title;
  };

  it.each([50, 54, 60, 66])('key starting at %i: no part of it survives the model mask', (at) => {
    const prompt = `${'w '.repeat(at / 2)}${KEY} and more words after the key`;
    expect(prompt.indexOf(KEY)).toBe(at);
    const shown = maskSecretsInText(titleOf(prompt));
    expect(shown).not.toContain(KEY.slice(0, 12));
    expect(shown.length).toBeLessThanOrEqual(70);
  });

  it('a title without a key is cut at 70 as before; a key inside it is left to the model mask', () => {
    const plain = `${'word '.repeat(20)}`.trim();
    expect(titleOf(plain)).toBe(plain.slice(0, 70));
    const early = `deploy with ${KEY} please ${'x '.repeat(40)}`;
    expect(titleOf(early)).toBe(early.slice(0, 70));
    expect(maskSecretsInText(titleOf(early))).toContain(SECRET_MASK);
  });
});
