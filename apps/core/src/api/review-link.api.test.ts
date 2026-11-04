import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewLinkBody } from '@agentdeck/contracts/core/review-link';
import { newId } from '../lib/ids/uuidv7.ts';
import { SESSION_PID, startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';
import type { ReviewLinkPort } from './review-link.ts';

/**
 * `POST /v1/review-link` (этап 10, F8) по настоящему HTTP: суд полномочий класса оценки (человек)
 * раньше открытия — токен сессии, пир из дерева сессии, без доказательства — отказ, порт не зовётся;
 * лишнее поле — 400; без дирижёра — 501; отказ открытия — 422 с кодом `review_link_*`; честное
 * доказательство отдаёт ответ порта как есть. Путь открытия (форж, git, задача) —
 * `bootstrap/review-link-wiring/review-link.integration.test.ts`.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const URL_OK = 'https://tracker.example.com/acme/app/-/merge_requests/7';

function body(proof: object, fields: Record<string, unknown> = {}, cmdId = newId()) {
  return { cmdId, fields: { url: URL_OK, repo: '/work/app', ...fields }, proof };
}

async function post(
  s: Stand,
  payload: unknown,
  token: string | null = TOKENS.core,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${s.url}/v1/review-link`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function linkStand(outcome: Awaited<ReturnType<ReviewLinkPort['open']>> | 'unwired') {
  const calls: ReviewLinkBody[] = [];
  const port: ReviewLinkPort = {
    open: async (b) => {
      calls.push(b);
      if (outcome === 'unwired') throw new Error('unreachable');
      return outcome;
    },
  };
  const s = await startStand(undefined, {
    reviewLink: () => (outcome === 'unwired' ? undefined : port),
  });
  stand = s;
  return { s, calls };
}

describe('POST /v1/review-link: human proof first, named refusals (stage 10, F8)', () => {
  it('no token, session token, session-descendant peer, no proof, extra field — refused before the port is called', async () => {
    const { s, calls } = await linkStand({ status: 422, code: 'review_link_closed', problems: [] });
    expect((await post(s, body({}), null)).status).toBe(401);
    const forged = await post(s, body(await s.nonce()), TOKENS.session);
    expect(forged).toMatchObject({ status: 403, body: { code: 'forged-authority' } });
    s.peer.direct = SESSION_PID;
    expect((await post(s, body(await s.nonce()))).body.code).toBe('forged-authority');
    s.peer.direct = 4242;
    expect((await post(s, body({}))).body.code).toBe('proof-required');
    const extra = await post(s, body(await s.nonce(), { command: 'node evil.mjs' }));
    expect(extra).toMatchObject({ status: 400, body: { code: 'bad-review-link' } });
    expect(calls).toEqual([]);
  });

  it('an honest proof reaches the port; its 422 code and problems go out as is; 202 forwards the reply', async () => {
    const refused = await linkStand({
      status: 422,
      code: 'review_link_foreign_repo',
      problems: ['MR !7 is not in the remote'],
    });
    const got = await post(refused.s, body(await refused.s.nonce(), { lang: 'en' }));
    expect(got).toMatchObject({
      status: 422,
      body: { code: 'review_link_foreign_repo', problems: ['MR !7 is not in the remote'] },
    });
    expect(refused.calls).toHaveLength(1);
    expect(refused.calls[0]!.fields).toEqual({ url: URL_OK, repo: '/work/app', lang: 'en' });
    await refused.s.close();
    stand = undefined;

    const taskId = newId();
    const ok = await linkStand({
      status: 202,
      reply: { taskId, replayed: false } as never,
    });
    const created = await post(ok.s, body(await ok.s.nonce()));
    expect(created).toMatchObject({ status: 202, body: { taskId } });
  });

  it('without a running conductor an honest request answers 501 not-wired', async () => {
    const { s } = await linkStand('unwired');
    const got = await post(s, body(await s.nonce()));
    expect(got).toMatchObject({ status: 501, body: { code: 'not-wired' } });
  });
});
