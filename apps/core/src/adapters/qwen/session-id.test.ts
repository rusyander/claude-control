import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planQwen as planWithLayer } from './qwen.ts';
import { qwenSessionId, SESSION_NAMESPACE, uuidV5 } from './session-id.ts';

const planQwen = (spec: SessionSpec, binding: Parameters<typeof planWithLayer>[1]) =>
  planWithLayer(spec, binding, trustedLayer(spec));

/**
 * Id сеанса ядра → id разговора Qwen Code. Форма, которую CLI принимает, — его собственное
 * выражение (0.24.3 `CALLER_SUPPLIED_SESSION_ID_REGEX`), скопированное как есть: v7 ядра оно
 * отвергает, производный v5 — принимает.
 */

const CLI_ACCEPTS = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function spec(over: Partial<SessionSpec>): SessionSpec {
  const cwd = join(tmpdir(), 'qwen-sid-work');
  return {
    sessionId: newId(),
    dir: join(tmpdir(), 'qwen-sid-session'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'qwen-sid-core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    ...over,
  };
}
const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe('qwen session id', () => {
  it('uuidV5 is RFC v5: the published vector (DNS namespace, python.org)', () => {
    expect(uuidV5(DNS_NAMESPACE, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('a core UUIDv7 maps to a v5 the CLI accepts — the same every time, another for another id', () => {
    const core = newId();
    expect(CLI_ACCEPTS.test(core)).toBe(false);
    const own = qwenSessionId(core);
    expect(own).not.toBeNull();
    expect(CLI_ACCEPTS.test(own!)).toBe(true);
    expect(own![14]).toBe('5');
    expect(own).toBe(uuidV5(SESSION_NAMESPACE, core));
    expect(qwenSessionId(core)).toBe(own);
    expect(qwenSessionId(core.toUpperCase())).toBe(own);
    expect(qwenSessionId(newId())).not.toBe(own);
    expect(SESSION_NAMESPACE).toBe('5f0c3a2e-8b41-4d6a-9e27-c1d84b7f3a90');
  });

  it('an id the CLI already accepts stays as is; a non-UUID has no CLI form', () => {
    const v4 = '33333333-3333-4333-8333-333333333333';
    expect(qwenSessionId(v4)).toBe(v4);
    const v5 = qwenSessionId(newId())!;
    expect(qwenSessionId(v5)).toBe(v5);
    expect(qwenSessionId('plain')).toBeNull();
    expect(qwenSessionId('')).toBeNull();
    // Неверный вариант (не 89ab) — не форма CLI, но UUID: производный.
    const badVariant = '33333333-3333-4333-c333-333333333333';
    expect(qwenSessionId(badVariant)).toBe(uuidV5(SESSION_NAMESPACE, badVariant));
  });

  it('the plan: --session-id carries the derived id; resume by the core id or by the CLI id names one conversation', () => {
    const core = newId();
    const own = qwenSessionId(core)!;
    const fresh = planQwen(spec({ sessionId: core }), null);
    expect(after(fresh.args, '--session-id')).toBe(own);
    expect(fresh.args).not.toContain('--resume');

    const byCore = planQwen(spec({ resume: { conversationId: core } }), null);
    expect(after(byCore.args, '--resume')).toBe(own);
    expect(byCore.args).not.toContain('--session-id');
    const byCli = planQwen(spec({ resume: { conversationId: own } }), null);
    expect(after(byCli.args, '--resume')).toBe(own);
    // Не UUID — как CLI его назвал, без перевода.
    const named = planQwen(spec({ resume: { conversationId: 'conv-9' } }), null);
    expect(after(named.args, '--resume')).toBe('conv-9');
  });
});
