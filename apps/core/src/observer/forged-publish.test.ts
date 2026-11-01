import { describe, expect, it } from 'vitest';
import type { ClosureRecord } from '@agentdeck/contracts/core/publish';
import { CLOSED_PUSH_URL } from '../lib/publish-alias.ts';
import { judgeForgedPublish, type ClosureNow, type ForgedPublishInput } from './forged-publish.ts';

/** G7: суд публикации мимо ядра по трём уликам; непрочитанный факт — `warn`, никогда «чисто». */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const UNIT = '01890000-0000-7000-8000-000000000001';

const record: ClosureRecord = {
  unitId: UNIT,
  copyDir: '/w/copy',
  pushurls: { origin: CLOSED_PUSH_URL },
  hooksPath: '/home/h/hooks/t/u',
  hooksDirFp: 'f'.repeat(64),
  commonAliases: { st: 'status', p: 'push' },
};
const now: ClosureNow = {
  pushurls: { origin: CLOSED_PUSH_URL },
  hooksPath: record.hooksPath,
  hooksDirFp: record.hooksDirFp,
  commonAliases: { st: 'status', p: 'push' },
  rewrites: [],
};

const clean = (over: Partial<ForgedPublishInput> = {}): ForgedPublishInput => ({
  subject: UNIT,
  refs: [
    {
      remote: 'origin',
      before: { 'refs/heads/unit': A },
      after: { value: { 'refs/heads/unit': A } },
    },
  ],
  unitShas: { value: {} },
  journaledPushes: [],
  closure: record,
  closureNow: { value: now },
  account: 'core-bot',
  forge: { value: [] },
  journaledForge: [],
  window: { from: 1000, to: 2000 },
  ...over,
});

const moved = (sha: string): Partial<ForgedPublishInput> => ({
  refs: [
    {
      remote: 'origin',
      before: { 'refs/heads/unit': A },
      after: { value: { 'refs/heads/unit': sha } },
    },
  ],
});

describe('forged-publish judge', () => {
  it('quiet when remote, forge and closure match the journal', () => {
    const out = judgeForgedPublish(clean());
    expect(out.fired).toBe(false);
    expect(out.signal).toBe('forged-publish');
  });

  it('remote-sha: our commit on the remote with no journaled push stops the step', () => {
    const out = judgeForgedPublish(clean({ ...moved(B), unitShas: { value: { [B]: true } } }));
    expect(out).toMatchObject({
      fired: true,
      severity: 'stop',
      action: 'stop-step',
      subject: UNIT,
    });
    expect(out.reasons).toEqual([`remote-sha: origin refs/heads/unit → ${B.slice(0, 12)}`]);
  });

  it('a new ref counts as a change; a foreign sha does not', () => {
    const out = judgeForgedPublish(
      clean({
        refs: [
          {
            remote: 'origin',
            before: { 'refs/heads/unit': A },
            after: { value: { 'refs/heads/unit': A, 'refs/heads/side': B, 'refs/heads/other': C } },
          },
        ],
        unitShas: { value: { [B]: true, [C]: false } },
      }),
    );
    expect(out.reasons).toEqual([`remote-sha: origin refs/heads/side → ${B.slice(0, 12)}`]);
  });

  it('a journaled push of the same ref and sha is the core; another sha is not', () => {
    const shas = { unitShas: { value: { [B]: true } } };
    const same = [{ remote: 'origin', ref: 'refs/heads/unit', sha: B }];
    expect(judgeForgedPublish(clean({ ...moved(B), ...shas, journaledPushes: same })).fired).toBe(
      false,
    );
    const other = [{ remote: 'origin', ref: 'refs/heads/unit', sha: C }];
    expect(judgeForgedPublish(clean({ ...moved(B), ...shas, journaledPushes: other })).fired).toBe(
      true,
    );
    const otherRef = [{ remote: 'origin', ref: 'refs/heads/x', sha: B }];
    expect(
      judgeForgedPublish(clean({ ...moved(B), ...shas, journaledPushes: otherRef })).fired,
    ).toBe(true);
  });

  it('forge-event: own account inside the window without a journaled action', () => {
    const forge = {
      value: [
        { id: '1', type: 'note' as const, author: 'core-bot', at: 1500, mrIid: 7, objectId: 'n1' },
        { id: '2', type: 'note' as const, author: 'reviewer', at: 1500, mrIid: 7 },
        { id: '3', type: 'note' as const, author: 'core-bot', at: 2500, mrIid: 7 },
        { id: '4', type: 'mr-open' as const, author: 'core-bot', at: 1200, ref: 'unit', mrIid: 8 },
      ],
    };
    const out = judgeForgedPublish(
      clean({ forge, journaledForge: [{ type: 'mr-open', ref: 'unit' }] }),
    );
    expect(out.reasons).toEqual(['forge-event: note !7 by core-bot']);
    // Тот же ответ, записанный в журнал, — работа ядра.
    const journaled = judgeForgedPublish(
      clean({
        forge,
        journaledForge: [
          { type: 'mr-open', ref: 'unit' },
          { type: 'note', mrIid: 7, objectId: 'n1' },
        ],
      }),
    );
    expect(journaled.fired).toBe(false);
    // Другой объект на том же MR — не наш.
    const otherNote = judgeForgedPublish(
      clean({
        forge,
        journaledForge: [
          { type: 'mr-open', ref: 'unit' },
          { type: 'note', mrIid: 7, objectId: 'n2' },
        ],
      }),
    );
    expect(otherNote.fired).toBe(true);
  });

  it('approval and merge by own account always fire, even if something journaled looks alike', () => {
    for (const type of ['approval', 'merge'] as const) {
      const out = judgeForgedPublish(
        clean({
          forge: { value: [{ id: '9', type, author: 'core-bot', at: 1100, mrIid: 3 }] },
          journaledForge: [{ type, mrIid: 3 }],
        }),
      );
      expect(out.reasons).toEqual([`forge-event: ${type} !3 by core-bot`]);
    }
  });

  it('config-drift: pushurl, new remote, hooksPath, hooks dir, publishing alias, insteadOf', () => {
    const out = judgeForgedPublish(
      clean({
        closureNow: {
          value: {
            pushurls: { origin: 'https://example.com/r.git', fork: '' },
            hooksPath: '',
            hooksDirFp: 'e'.repeat(64),
            commonAliases: { st: 'status -sb', p: 'push', ship: '!git push origin HEAD' },
            rewrites: ['https://example.com/', 'agentdeck-closed://'],
          },
        },
      }),
    );
    expect(out.reasons).toEqual([
      'config-drift: remote.fork.pushurl',
      'config-drift: remote.origin.pushurl',
      'config-drift: core.hooksPath',
      'config-drift: core hooks dir',
      'config-drift: alias.ship',
      'config-drift: insteadOf agentdeck-closed://',
    ]);
  });

  it('an unread fact is a warn naming it, never silence; with evidence it rides along', () => {
    const out = judgeForgedPublish(
      clean({
        refs: [{ remote: 'origin', before: null, after: { unknown: 'timeout' } }],
        forge: { unknown: 'forge 503' },
        closureNow: { unknown: 'git config: exit 128' },
      }),
    );
    expect(out).toMatchObject({ fired: true, severity: 'warn', action: 'show' });
    expect(out.reasons).toEqual([
      'unread: ls-remote origin: timeout',
      'unread: forge activity: forge 503',
      'unread: copy closure state: git config: exit 128',
    ]);
    const noBase = judgeForgedPublish(
      clean({ refs: [{ remote: 'origin', before: null, after: { value: {} } }] }),
    );
    expect(noBase.reasons).toEqual(['unread: remote-refs baseline of origin: absent']);
    const notAsked = judgeForgedPublish(clean({ ...moved(B), unitShas: { value: {} } }));
    expect(notAsked.severity).toBe('warn');
    const notRead = judgeForgedPublish(clean({ ...moved(B), unitShas: { unknown: 'rev-list' } }));
    expect(notRead.reasons).toEqual([`unread: unit reachability of ${B.slice(0, 12)}: not read`]);
    const both = judgeForgedPublish(
      clean({
        ...moved(B),
        unitShas: { value: { [B]: true } },
        forge: { unknown: 'forge 503' },
      }),
    );
    expect(both).toMatchObject({ severity: 'stop', action: 'stop-step' });
    expect(both.reasons.at(-1)).toBe('unread: forge activity: forge 503');
  });

  it('no forge configured and no closure recorded: those checks are not asked', () => {
    const out = judgeForgedPublish(clean({ account: null, forge: null, closure: null }));
    expect(out.fired).toBe(false);
  });
});
