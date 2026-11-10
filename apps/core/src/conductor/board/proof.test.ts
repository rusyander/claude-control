import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { checkStartProof, type ProofConfigCmd } from './proof.ts';

/**
 * Доказательство старта записью настройки (этап 12, Z7, P183): запись должна быть в истории,
 * сделана человеком, включать автоочередь ИМЕННО источника записи — и автоочередь включена сейчас.
 */

const cmdId = newId();
const entry = (system = 'jira-main'): BoardEntry => ({
  entryId: newId(),
  state: 'queued',
  rank: 0,
  stop: 'mr',
  preset: 'tracker-ticket',
  source: { kind: 'tracker', system, key: 'PROJ-1', title: 'T' },
  launch: { kind: 'fields', fields: { title: 'T', request: 'R' } },
  proof: { kind: 'config', cmdId },
  createdAt: 1,
});

const human = (detail = 'autoQueue on jira-main', by = 'nonce+peer'): ProofConfigCmd => ({
  by,
  warnings: [{ section: 'inbox', detail }],
});

const judge = (e: BoardEntry, cmd: ProofConfigCmd | undefined, on = true) =>
  checkStartProof(e, {
    configCmdExists: () => cmd !== undefined,
    configCmd: () => cmd,
    autoQueueOf: () => on,
  });

describe('board start proof: config kind (P183)', () => {
  it('a human config write that enabled auto-queue of this source, still on → start', () => {
    expect(judge(entry(), human())).toEqual({ ok: true });
    expect(judge(entry(), human('autoQueue on jira-main', 'device-signature'))).toEqual({
      ok: true,
    });
  });

  it('auto-queue switched off since → refused with the source named, even for a good write', () => {
    expect(judge(entry(), human(), false)).toEqual({
      ok: false,
      reason: 'auto-queue is off for tracker sources now (source jira-main)',
    });
    // Выключенная сейчас автоочередь — первая причина: о чужой записи человеку знать уже незачем.
    expect(judge(entry(), human('autoQueue on other', 'session-token'), false)).toEqual({
      ok: false,
      reason: 'auto-queue is off for tracker sources now (source jira-main)',
    });
  });

  it('a write not by a human, of another source, or absent → refused with its reason', () => {
    expect(judge(entry(), human('autoQueue on jira-main', 'session-token'))).toEqual({
      ok: false,
      reason: `config write ${cmdId} was not made by a human`,
    });
    expect(judge(entry(), human('autoQueue on other'))).toEqual({
      ok: false,
      reason: `config write ${cmdId} did not enable auto-queue for source jira-main`,
    });
    expect(judge(entry(), undefined)).toEqual({
      ok: false,
      reason: `config write ${cmdId} is not in the config history`,
    });
  });
});
