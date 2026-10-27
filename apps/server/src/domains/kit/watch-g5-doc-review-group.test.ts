import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Аудит g5 26.10, L5: `PostToolUse:Write` на отчёте звена (58 КБ) вписал группе разделения весь
 * список ревизии агентских доков копии — группа с ним ничего сделать не может. В прогоне группы
 * панели (`AGENTDECK_GROUP_STAGE`) ревизия молчит, и дневная отметка остаётся нетронутой: следующая
 * сессия человека её получит. Через настоящий диспетчер `run.mjs post-edit`.
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
      AGENTDECK_GROUP_STAGE: '',
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

describe('doc-daily-review: молчит в прогоне группы панели (g5 L5)', () => {
  it('группа — без ревизии; та же запись вне группы — ревизия на месте (отметка не потрачена)', () => {
    const root = project('group');
    expect(postWrite(root, { AGENTDECK_GROUP_STAGE: 'deliver' })).not.toContain(
      '[doc-daily-review]',
    );
    expect(postWrite(root)).toContain('[doc-daily-review]');
  });
});
