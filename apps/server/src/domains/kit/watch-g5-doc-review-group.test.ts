import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Аудит g5 26.10, L5: `PostToolUse:Write` на отчёте звена (58 КБ) вписал группе разделения весь
 * список ревизии агентских доков копии — группа с ним ничего сделать не может. В сессии шага ядра
 * (`AGENTDECK_STEP_KIND`, кроме `chat` — там за панелью человек) ревизия молчит, и дневная отметка
 * остаётся нетронутой: следующая сессия человека её получит. Через настоящий диспетчер `run.mjs post-edit`.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-g5-doc-review-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BIG = '# Notes\n\nA long agent document that is well over the size budget. '.repeat(400);

function project(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.agent'), { recursive: true });
  writeFileSync(join(root, '.agent', 'notes.md'), BIG);
  return root;
}
function postWrite(cwd: string, env: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [DISPATCH, 'post-edit'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_STEP_KIND: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      ...env,
    },
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'kit-g5-doc-review',
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, '.agent', 'notes.md'), content: 'x' },
      cwd,
    }),
    timeout: 15_000,
  });
  return `${r.stdout}${r.stderr}`;
}

describe('doc-daily-review: молчит в сессии шага ядра (g5 L5)', () => {
  it('шаг ядра — без ревизии; та же запись вне ядра — ревизия на месте (отметка не потрачена)', () => {
    const root = project('group');
    for (const kind of ['implement', 'review', 'fix'])
      expect(postWrite(root, { AGENTDECK_STEP_KIND: kind }), kind).not.toContain(
        '[doc-daily-review]',
      );
    expect(postWrite(root)).toContain('[doc-daily-review]');
  });

  it('чат ядра — человек за панелью: ревизия звучит', () => {
    expect(postWrite(project('chat'), { AGENTDECK_STEP_KIND: 'chat' })).toContain(
      '[doc-daily-review]',
    );
  });
});
