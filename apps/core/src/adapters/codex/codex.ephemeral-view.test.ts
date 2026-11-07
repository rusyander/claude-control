import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { RPC_VIEW } from '../rpc-stdio/rpc-view.ts';
import { CODEX_CHANNELS, createCodexAdapter } from './codex.ts';

/**
 * Сеанс без следа (замер базы, `spec.ephemeral`) у Codex: вход диалекта несёт `ephemeral: true` —
 * его `thread/start` открывает эфемерную нить без файла разговора. Вход пишется в `rpc-view.json`
 * ДО запуска CLI, поэтому проверяется настоящим `launch` переходника с несуществующим бинарём:
 * отказ «не найден» до порождения процесса, файл входа уже на диске.
 */

const base = mkdtempSync(join(tmpdir(), 'codex-eph-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let seq = 0;
function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  seq += 1;
  return {
    sessionId: `s${seq}`,
    dir: join(base, 'sessions', `s${seq}`),
    cwd: join(base, 'work'),
    brief: 'B',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(base, 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'off', skills: 'off' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 'st',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'x',
    },
    coreHook: 'C:\\n\\node.exe C:\\c\\run.ts hook',
    endpoint: {
      channel: CODEX_CHANNELS[0]!,
      endpoint: {
        baseUrl: 'http://127.0.0.1:9',
        dialect: 'openai-responses',
        model: 'm',
        key: 'k',
      },
    },
    ...over,
  };
}

async function viewOf(s: SessionSpec): Promise<Record<string, unknown>> {
  const got = await createCodexAdapter({ command: 'agentdeck-no-such-codex' }).launch(s);
  expect(got).toMatchObject({ ok: false, reason: /not found/ });
  return JSON.parse(readFileSync(join(s.dir, RPC_VIEW), 'utf8')) as Record<string, unknown>;
}

describe('codex: an ephemeral session carries ephemeral into the dialect input', () => {
  it('ephemeral spec → the view input says ephemeral: true; an ordinary spec — no field', async () => {
    expect(await viewOf(spec({ ephemeral: true }))).toMatchObject({ ephemeral: true });
    expect(await viewOf(spec())).not.toHaveProperty('ephemeral');
  });
});
