import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Вывод Bash больше BASH_MAX_OUTPUT_LENGTH (панель ставит его низко, `bashOutputMaxChars`) CLI сохраняет в файл и
 * показывает модели превью ~2 КБ (живой случай g1 #176, 27.10: по превью 9,6 КБ диффа группа решила, что правки
 * «просто дописывают», а невиденная часть заменяла абзац). Пункт набора после такого вызова говорит, что видено
 * только превью и где весь вывод. Настоящий CLI с этим полем — `tools/qa/check-persisted-output-hint.mjs`.
 */

const KIT = builtinKitDir();
const LIB = join(KIT, 'hooks', 'lib', 'persisted-output-hint.mjs');
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-persisted-hint-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Lib = { default: (input: object) => string | null };
const lib = (await import(pathToFileURL(LIB).href)) as Lib;

// Форма живого ответа: поля BashOutput из sdk-tools.d.ts, путь как у g9 #1364.
const FILE = 'C:\\Users\\u\\.claude\\projects\\p\\s\\tool-results\\bn6pai3es.txt';
const PERSISTED = {
  stdout: 'preview…',
  stderr: '',
  interrupted: false,
  persistedOutputPath: FILE,
  persistedOutputSize: 9830,
};

const post = (toolResponse: object, tool = 'Bash') => ({
  hook_event_name: 'PostToolUse',
  tool_name: tool,
  tool_input: { command: 'git diff main -- messages.mdx' },
  tool_response: toolResponse,
  session_id: 'persistedhint01',
  cwd: dir,
});

describe('persisted-output-hint — модель видела только превью вывода', () => {
  it('сохранённый вывод: размер, путь и правило «не судить по невиденному»', () => {
    const hint = lib.default(post(PERSISTED));
    expect(hint).toContain('persisted-output:');
    expect(hint).toContain('9.6 KB');
    expect(hint).toContain(FILE);
    expect(hint).toMatch(/Judge nothing from the unseen part/);
  });

  it('без размера — подсказка без числа', () => {
    const { persistedOutputSize: _drop, ...noSize } = PERSISTED;
    const hint = lib.default(post(noSize)) ?? '';
    expect(hint).toContain('the whole output is in');
    expect(hint).not.toMatch(/the whole [\d.]+ KB/);
  });

  it.each([
    ['вывод целиком в ответе', { stdout: 'ok', stderr: '', interrupted: false }],
    ['пустой путь', { ...PERSISTED, persistedOutputPath: '  ' }],
    ['ответ строкой (другой CLI)', 'Output too large…'],
  ])('молчит: %s', (_name, resp) => {
    expect(lib.default(post(resp as object))).toBeNull();
  });

  // Сквозной путь: диспетчер run.mjs post-any → пункт → additionalContext PostToolUse.
  it('диспетчер набора отдаёт подсказку контекстом PostToolUse, только для Bash', () => {
    const run = (input: object) => {
      const out = spawnSync(process.execPath, [DISPATCH, 'post-any'], {
        input: JSON.stringify(input),
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTDECK_KIT_VARIANT: '',
          AGENTDECK_STEP_KIND: '',
          AGENTDECK_KIT_STATE: join(dir, 'state'),
        },
        timeout: 15_000,
      }).stdout.trim();
      return out
        ? (JSON.parse(out) as {
            hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
          })
        : {};
    };
    const hit = run(post(PERSISTED));
    expect(hit.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(hit.hookSpecificOutput?.additionalContext ?? '').toContain(`persisted-output:`);
    expect(hit.hookSpecificOutput?.additionalContext ?? '').toContain(FILE);
    expect(
      run(post({ stdout: 'ok', stderr: '', interrupted: false })).hookSpecificOutput
        ?.additionalContext ?? '',
    ).not.toContain('persisted-output:');
    expect(run(post(PERSISTED, 'Read')).hookSpecificOutput?.additionalContext ?? '').not.toContain(
      'persisted-output:',
    );
  });
});
