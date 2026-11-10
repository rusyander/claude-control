import { describe, expect, it } from 'vitest';
import { boardEntriesBodySchema, boardMoveBodySchema } from '@agentdeck/contracts/core/panel-api';
import { boardEntriesBody, boardMoveBody, boardMoveRefusalOf } from './useCoreBoard';

const proof = { nonce: 'n-1', page: '0190f0c0-0000-7000-8000-000000000001' };
const ID = '0190f0c0-0000-7000-8000-0000000000aa';
const CMD = '0190f0c0-0000-7000-8000-0000000000cc';

describe('core board requests', () => {
  it('a move body carries exactly one target and passes the core schema', () => {
    const entry = boardMoveBody({ entryId: ID, to: 'queue' }, proof, CMD);
    expect(entry).toEqual({ cmdId: CMD, entryId: ID, to: 'queue', proof });
    expect(boardMoveBodySchema.safeParse(entry).success).toBe(true);
    const task = boardMoveBody({ taskId: ID, to: 'rejected', before: undefined }, proof, CMD);
    expect(task).toEqual({ cmdId: CMD, taskId: ID, to: 'rejected', proof });
    expect(boardMoveBodySchema.safeParse(task).success).toBe(true);
  });

  it('a new-entries body passes the core schema with the chosen stop', () => {
    const body = boardEntriesBody(
      'queue',
      [
        {
          stop: 'plan',
          preset: 'feature',
          source: { kind: 'manual', title: 'T' },
          launch: { kind: 'fields', fields: { title: 'T' } },
        },
      ],
      proof,
      CMD,
    );
    expect(boardEntriesBodySchema.safeParse(body).success).toBe(true);
    expect(body.entries[0]?.stop).toBe('plan');
  });

  it('a 409 refusal yields the core reason and the moves allowed now', () => {
    const error = Object.assign(new Error('Request failed with status code 409'), {
      response: {
        status: 409,
        data: { error: 'move not allowed', code: 'move-not-allowed', allowed: ['queue', 7] },
      },
    });
    expect(boardMoveRefusalOf(error)).toEqual({
      status: 409,
      code: 'move-not-allowed',
      reason: 'move not allowed',
      raw: 'move not allowed',
      allowed: ['queue'],
    });
    // Тело `board-move.ts`: `error` общее, `reason` — проза `moves.ts`; она и есть `raw`.
    const real = Object.assign(new Error('Request failed with status code 409'), {
      response: {
        status: 409,
        data: {
          error: 'Ход доски не разрешён',
          code: 'move-not-allowed',
          allowed: ['restore'],
          reason: 'move rejected is not allowed from rejected',
        },
      },
    });
    expect(boardMoveRefusalOf(real)).toMatchObject({
      reason: 'Ход доски не разрешён',
      raw: 'move rejected is not allowed from rejected',
    });
    const offline = boardMoveRefusalOf(new Error('Network Error'));
    expect(offline.status).toBeUndefined();
    expect(offline.reason).toBe('Network Error');
    expect(offline.allowed).toBeUndefined();
  });
});
