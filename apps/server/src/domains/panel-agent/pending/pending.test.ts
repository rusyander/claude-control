import { describe, it, expect, vi, afterEach } from 'vitest';
import { PanelPendingActions } from './pending.ts';

const request = {
  name: 'create_project',
  risk: 'change' as const,
  preview: { summary: 's', fields: [] },
};

describe('PanelPendingActions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('клик решает карточку один раз: повтор — already-decided, чужой id — not-found', async () => {
    const registry = new PanelPendingActions(60_000);
    const handle = registry.create({ ...request, conversationId: 'c1' });
    expect(registry.list()).toEqual([handle.pending]);
    expect(handle.pending.conversationId).toBe('c1');

    expect(registry.decide(handle.pending.id, 'approve')).toBe('ok');
    await expect(handle.settled).resolves.toBe('approve');
    expect(registry.list()).toEqual([]);
    expect(registry.decide(handle.pending.id, 'reject')).toBe('already-decided');
    expect(registry.decide('nope', 'reject')).toBe('not-found');
  });

  it('таймаут разрешает ожидание и срок виден в карточке', async () => {
    vi.useFakeTimers();
    const registry = new PanelPendingActions(1_000);
    const handle = registry.create(request);
    expect(Date.parse(handle.pending.expiresAt) - Date.parse(handle.pending.createdAt)).toBe(1_000);
    vi.advanceTimersByTime(1_000);
    await expect(handle.settled).resolves.toBe('timeout');
    expect(registry.decide(handle.pending.id, 'approve')).toBe('already-decided');
  });

  it('отмена и выход панели снимают карточки; после отмены клик не проходит', async () => {
    const registry = new PanelPendingActions(60_000);
    const one = registry.create(request);
    const two = registry.create(request);
    registry.cancel(one.pending.id);
    registry.cancel(one.pending.id);
    await expect(one.settled).resolves.toBe('cancelled');
    registry.cancelAll();
    await expect(two.settled).resolves.toBe('cancelled');
    expect(registry.list()).toEqual([]);
    expect(registry.decide(two.pending.id, 'approve')).toBe('already-decided');
  });

  it('память решённых ограничена: самые старые забываются', () => {
    const registry = new PanelPendingActions(60_000);
    const first = registry.create(request);
    registry.cancel(first.pending.id);
    for (let index = 0; index < 500; index += 1) {
      registry.cancel(registry.create(request).pending.id);
    }
    expect(registry.decide(first.pending.id, 'approve')).toBe('not-found');
  });
});
