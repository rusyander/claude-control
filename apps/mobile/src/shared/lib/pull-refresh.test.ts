import { describe, expect, it } from 'vitest';
import { pullOnce } from './pull-refresh';

describe('pullOnce', () => {
  it('крутилка горит, пока идут все перезапросы, и гаснет после последнего', async () => {
    const states: boolean[] = [];
    let release: () => void = () => undefined;
    const slow = () => new Promise<void>((resolve) => (release = resolve));
    const pending = pullOnce([() => Promise.resolve(), slow], (value) => states.push(value));
    await Promise.resolve();
    expect(states).toEqual([true]);
    release();
    await pending;
    expect(states).toEqual([true, false]);
  });

  it('гаснет и тогда, когда панель не ответила', async () => {
    const states: boolean[] = [];
    await pullOnce([() => Promise.reject(new Error('panel down'))], (value) => states.push(value));
    expect(states).toEqual([true, false]);
  });
});
