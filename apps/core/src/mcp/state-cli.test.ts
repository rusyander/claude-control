import { describe, expect, it } from 'vitest';
import type { HttpJsonOutcome } from '../platform/http-json.ts';
import { runStateCli, type StateCliDeps } from './state-cli.ts';

/**
 * G8 — разбор `agentdeck state`: подкоманда и `--field`, ядро → документ, отказ/недоступность →
 * снимок с `source: 'snapshot'` (что бы ни лежало в поле файла), нет обоих → 1, неверный вызов → 2.
 * Токен сессии вычищается из вывода, даже если его вернул процесс на порту ядра.
 */

const TOKEN = 'tok-secret-value';
const CORE_DOC = { v: 1, source: 'core', task: 't', step: { id: 's1', kind: 'work' } };

function harness(reply: HttpJsonOutcome, snapshot?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const deps: StateCliDeps = {
    env: {
      AGENTDECK_CORE_URL: 'http://127.0.0.1:9',
      AGENTDECK_SESSION_TOKEN: TOKEN,
      AGENTDECK_STATE: '/x/state.json',
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    http: async (call) => {
      asked.push(`${call.method} ${call.url} ${call.bearer === TOKEN}`);
      return reply;
    },
    readFile: () => (snapshot === undefined ? { absent: true } : { value: Buffer.from(snapshot) }),
  };
  return { deps, out, err, asked };
}

const ok = (body: unknown): HttpJsonOutcome => ({ kind: 'reply', status: 200, body });
const down: HttpJsonOutcome = { kind: 'unreachable', reason: 'ECONNREFUSED', refused: true };

describe('G8 agentdeck state command (mcp/state-cli)', () => {
  it('core answers → the doc pretty-printed; --field prints a string raw and an object as JSON', async () => {
    const h = harness(ok(CORE_DOC));
    expect(await runStateCli(['state'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(''))).toEqual(CORE_DOC);
    expect(h.asked).toEqual(['GET http://127.0.0.1:9/v1/session/state true']);
    const f = harness(ok(CORE_DOC));
    expect(await runStateCli(['state', '--field', 'step.id'], f.deps)).toBe(0);
    expect(f.out.join('')).toBe('s1\n');
    const o = harness(ok(CORE_DOC));
    expect(await runStateCli(['state', '--field', 'step'], o.deps)).toBe(0);
    expect(o.out.join('')).toBe('{"id":"s1","kind":"work"}\n');
  });

  it('core unreachable or refusing → snapshot forced to source snapshot, exit 0, reason on stderr', async () => {
    for (const reply of [
      down,
      { kind: 'reply', status: 501, body: { code: 'not-implemented' } } as const,
    ]) {
      const h = harness(reply, JSON.stringify({ ...CORE_DOC, source: 'core' }));
      expect(await runStateCli(['state', '--field', 'source'], h.deps)).toBe(0);
      expect(h.out.join('')).toBe('snapshot\n');
      expect(h.err.join('')).toMatch(
        /core (unreachable|answered 501 not-implemented).*launch snapshot/,
      );
    }
  });

  it('no core and no snapshot → 1; unknown command, extra args → 2; a missing field → 1', async () => {
    const none = harness(down);
    expect(await runStateCli(['state'], none.deps)).toBe(1);
    expect(none.err.join('')).toContain('snapshot /x/state.json absent');
    expect(await runStateCli([], harness(ok(CORE_DOC)).deps)).toBe(2);
    expect(await runStateCli(['status'], harness(ok(CORE_DOC)).deps)).toBe(2);
    expect(await runStateCli(['state', '--field'], harness(ok(CORE_DOC)).deps)).toBe(2);
    expect(await runStateCli(['state', '--field', 'no.such'], harness(ok(CORE_DOC)).deps)).toBe(1);
    const bad = harness(down, '{not json');
    expect(await runStateCli(['state'], bad.deps)).toBe(1);
    expect(bad.err.join('')).toContain('snapshot is not JSON');
  });

  it('the session token never reaches stdout or stderr, even when the port answers with it', async () => {
    const h = harness(ok({ ...CORE_DOC, echo: TOKEN }));
    expect(await runStateCli(['state'], h.deps)).toBe(0);
    const e = harness({ kind: 'unreachable', reason: `refused ${TOKEN}`, refused: true });
    expect(await runStateCli(['state'], e.deps)).toBe(1);
    for (const text of [...h.out, ...h.err, ...e.out, ...e.err]) expect(text).not.toContain(TOKEN);
    expect(h.out.join('')).toContain('<session-token>');
  });
});
