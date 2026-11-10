import { describe, expect, it } from 'vitest';
import { TRACKER_ERROR_CODES, TrackerError, isTrackerError, trackerErrorCodeOf } from './index.ts';

/** Отказ трекера — код по ответу, а не строка: входящие ядра и панель выбирают свой текст по нему. */
describe('trackers > error codes', () => {
  it('maps every response status to its code, success to null', () => {
    expect(trackerErrorCodeOf(200)).toBeNull();
    expect(trackerErrorCodeOf(204)).toBeNull();
    expect(trackerErrorCodeOf(401)).toBe('unauthorized');
    expect(trackerErrorCodeOf(403)).toBe('forbidden');
    expect(trackerErrorCodeOf(404)).toBe('not-found');
    expect(trackerErrorCodeOf(429)).toBe('rate-limited');
    expect(trackerErrorCodeOf(500)).toBe('server-error');
    expect(trackerErrorCodeOf(503)).toBe('server-error');
    expect(trackerErrorCodeOf(400)).toBe('bad-response');
    expect(trackerErrorCodeOf(302)).toBe('bad-response');
  });

  it('TrackerError carries code, system and status, never a body', () => {
    const error = new TrackerError('forbidden', 'Jira', 403);
    expect(error.message).toBe('Jira: forbidden (403)');
    expect([error.code, error.system, error.status]).toEqual(['forbidden', 'Jira', 403]);
    expect(new TrackerError('unreachable', 'Jira').message).toBe('Jira: unreachable');
    expect(isTrackerError(error)).toBe(true);
    expect(isTrackerError(new Error('x'))).toBe(false);
    expect(TRACKER_ERROR_CODES).toContain(error.code);
  });
});
