import { boardMoveBodySchema } from '@agentdeck/contracts/core/panel-api';
import { describe, expect, it } from 'vitest';
import { canSetPreset, presetChoices, presetRefusalOf, setPresetBody } from './entryPreset.lib';

const ID = '01900000-0000-7000-8000-000000000001';
const PROOF = { nonce: 'n', page: '01900000-0000-7000-8000-0000000000aa' };

describe('entry preset (W2-D, P164)', () => {
  it('the choice shows only on an entry the core allowed set-preset', () => {
    expect(canSetPreset({ kind: 'entry', moves: ['queue', 'set-preset'] })).toBe(true);
    expect(canSetPreset({ kind: 'entry', moves: ['queue'] })).toBe(false);
    expect(canSetPreset({ kind: 'task', moves: ['set-preset'] })).toBe(false);
  });

  it('a preset outside the board list stays first so the choice shows the truth', () => {
    expect(presetChoices('feature')[0]).toBe('feature');
    expect(presetChoices('team-flow')).toEqual([
      'team-flow',
      'feature',
      'bug-fix',
      'refactor',
      'review-only',
      'tracker-ticket',
      'lead',
    ]);
  });

  it('the body is a set-preset move with the preset and passes the contract schema', () => {
    const body = setPresetBody(ID, 'bug-fix', PROOF, ID);
    expect(body).toEqual({
      cmdId: ID,
      entryId: ID,
      to: 'set-preset',
      preset: 'bug-fix',
      proof: PROOF,
    });
    expect(boardMoveBodySchema.safeParse(body).success).toBe(true);
    expect(boardMoveBodySchema.safeParse({ ...body, to: 'queue' }).success).toBe(false);
  });

  it('the refusal maps the core English prose to a localized key; raw prose kept for the hint', () => {
    const refused = (reason: string) => ({
      response: { status: 409, data: { error: 'Ход доски не разрешён', reason } },
    });
    const ticket =
      'preset tracker-ticket: the tracker-ticket preset needs a tracker snapshot in the launch source (kind tracker)';
    expect(presetRefusalOf(refused(ticket))).toEqual({
      key: 'trackerSnapshot',
      values: {},
      raw: ticket,
    });
    const key = (reason: string) => presetRefusalOf(refused(reason)).key;
    expect(key('preset ask: the ask preset is created only by its own route, not the board')).toBe(
      'ask',
    );
    expect(
      presetRefusalOf(
        refused(
          'preset feature: the entry runs library scenario team-flow; change it in the launch form',
        ),
      ).values,
    ).toEqual({ id: 'team-flow' });
    expect(key('preset chat: a chat is not a board task')).toBe('chat');
    expect(
      key(
        'preset answer-reviewers: answer-reviewers tasks are opened by the forge poll, not from the board',
      ),
    ).toBe('answerReviewers');
    expect(presetRefusalOf(refused('preset zzz: unknown preset zzz')).values).toEqual({
      preset: 'zzz',
    });
    expect(key('preset feature: a link launch needs the review-link preset')).toBe(
      'linkNeedsReview',
    );
    expect(key('preset review-link: the review-link preset starts from a link launch')).toBe(
      'reviewNeedsLink',
    );
    expect(
      key('preset feature: sources: group items and other sources in one estimate — send …'),
    ).toBe('groupMixed');
    expect(key('move set-preset is not allowed from rejected')).toBe('notAllowed');
    expect(key('no board entry 0190')).toBe('gone');
    expect(presetRefusalOf(refused('preset lead: something new'))).toEqual({
      key: 'generic',
      values: {},
      raw: 'preset lead: something new',
    });
    expect(presetRefusalOf(new Error('Network Error'))).toEqual({
      key: 'noAnswer',
      values: {},
      raw: 'Network Error',
    });
  });
});
