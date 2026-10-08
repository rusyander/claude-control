import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HookDraft } from '@agentdeck/contracts';
import { generateHookScript } from './hook-scripts.ts';

/**
 * Ревью 28.09 (F-136): текст сообщения и описание вставлялись в исходник
 * сгенерированного хука почти как есть — `${…}` в сообщении исполнялся, а
 * перенос строки в описании выводил текст из комментария в код. Проверяем,
 * запуская сам сгенерированный файл.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-hook-scripts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Partial<HookDraft>): HookDraft =>
  ({
    event: 'PreToolUse',
    matchers: [],
    isEnabled: true,
    groupIds: [],
    guardPatterns: [],
    scriptName: 'probe',
    ...over,
  }) as HookDraft;

function run(path: string, input = '{}') {
  return spawnSync(process.execPath, [path], { input, encoding: 'utf8' });
}

describe('generateHookScript: вставка текста', () => {
  const tricky = 'a ${process.exit(7)} b \\n `c`';

  it('сообщение выводится буквально, `${…}` не исполняется', () => {
    const { path } = generateHookScript(dir, draft({ template: 'message', message: tricky }));
    const result = run(path);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(tricky);
  });

  it('сообщение стража выводится буквально', () => {
    const { path } = generateHookScript(
      dir,
      draft({ template: 'guard', message: tricky, guardPatterns: ['rm -rf'] }),
    );
    const result = run(path, JSON.stringify({ tool_input: { command: 'rm -rf /' } }));
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(tricky);
  });

  it('перенос строки в описании остаётся комментарием', () => {
    const { path } = generateHookScript(
      dir,
      draft({ template: 'blank', description: 'первая\nprocess.exit(9)' }),
    );
    expect(run(path).status).toBe(0);
  });

  // Для JavaScript концом строки служат и одиночный CR, и U+2028/U+2029: текст
  // после них выходил из комментария в код во всех шаблонах.
  it.each(['\r', '\u2028', '\u2029'])(
    'любой разделитель строк JavaScript в описании остаётся комментарием (%j)',
    (separator) => {
      for (const template of ['blank', 'message', 'guard', 'shell'] as const) {
        const { path } = generateHookScript(
          dir,
          draft({ template, description: `первая${separator}process.exit(9)` }),
        );
        expect({ template, status: run(path).status }).not.toEqual({ template, status: 9 });
      }
    },
  );
});
