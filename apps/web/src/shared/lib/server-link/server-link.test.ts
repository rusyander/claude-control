import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LINK_GRACE_MS,
  getServerLink,
  reportLinkError,
  reportLinkUp,
  resetServerLink,
  subscribeServerLink,
} from './server-link';

describe('server link state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetServerLink();
  });
  afterEach(() => {
    resetServerLink();
    vi.useRealTimers();
  });

  it('a short break (server restart) is never announced as «down»', () => {
    reportLinkUp();
    reportLinkError();
    vi.advanceTimersByTime(LINK_GRACE_MS - 1);
    reportLinkUp();
    vi.advanceTimersByTime(LINK_GRACE_MS * 2);
    expect(getServerLink()).toBe('up');
  });

  it('no reopen within the grace → «down», once; reopen → «up»', () => {
    const changes: string[] = [];
    const off = subscribeServerLink(() => changes.push(getServerLink()));
    reportLinkUp();
    reportLinkError();
    // Повторные ошибки переподключений срок не продлевают и второй «down» не дают.
    vi.advanceTimersByTime(LINK_GRACE_MS / 2);
    reportLinkError();
    vi.advanceTimersByTime(LINK_GRACE_MS / 2);
    reportLinkError();
    vi.advanceTimersByTime(LINK_GRACE_MS);
    reportLinkUp();
    off();
    expect(changes).toEqual(['up', 'down', 'up']);
  });
});
