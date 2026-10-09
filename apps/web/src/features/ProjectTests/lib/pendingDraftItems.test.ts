import { describe, expect, it } from 'vitest';
import type { ProjectTestDraftSummary } from '@agentdeck/contracts';
import { pendingDraftItems } from './pendingDraftItems';

const draft = (
  runId: string,
  status: ProjectTestDraftSummary['status'],
  pending: number,
): ProjectTestDraftSummary => ({
  runId,
  createdAt: '2026-10-08T15:30:00.000Z',
  status,
  file: `.agent/tests/drafts/${runId}.draft.json`,
  total: pending + 1,
  pending,
  accepted: 1,
  rejected: 0,
});

describe('pendingDraftItems', () => {
  it('складывает ждущие правки всех непринятых черновиков, а не только самого нового', () => {
    expect(
      pendingDraftItems([
        draft('chat-new', 'pending', 1),
        draft('chat-edit-core-001', 'pending', 2),
      ]),
    ).toBe(3);
  });

  it('принятый и отклонённый черновики не считаются, даже если в них остались строки', () => {
    expect(
      pendingDraftItems([
        draft('a', 'applied', 4),
        draft('b', 'rejected', 1),
        draft('c', 'pending', 1),
      ]),
    ).toBe(1);
  });

  it('черновиков нет — ноль', () => {
    expect(pendingDraftItems([])).toBe(0);
  });
});
