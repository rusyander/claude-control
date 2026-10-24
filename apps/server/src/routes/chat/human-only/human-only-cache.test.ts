import { describe, expect, it } from 'vitest';
import { checkHumanCaller } from './human-only.ts';
import { deps, request, row, TABLE, WINDOWS } from './human-gate.fixture.ts';

/**
 * Память ворот «только человек» за пределами браузеров (24.10): прокси Tailscale
 * этой машины узнаётся по номеру и времени создания процесса, а ключ доступа и
 * адрес tailnet судятся на каждом вызове. Ключ прокси локального вызова не пускает.
 */
describe('human gate memory: Tailscale proxy', () => {
  it('strict: the Tailscale proxy is remembered by pid and creation time, the key and tailnet address are judged every call, and it never passes a local call', async () => {
    const PROXY = 60;
    const known = new Set<string>();
    const knownProxies = new Set<string>();
    let reads = 0;
    const viaProxy = {
      ...deps(PROXY, { known }),
      knownProxies,
      readTable: async () => [...TABLE, row(PROXY, 1)],
      readFacts: async () => {
        reads += 1;
        return new Map([...WINDOWS, [PROXY, { pid: PROXY, name: 'tailscaled.exe', session: 0 }]]);
      },
    };
    const phone = { 'x-forwarded-for': '100.101.1.2', authorization: 'Bearer x' };
    expect(await checkHumanCaller(request({ headers: phone }), viaProxy)).toEqual({ ok: true });
    expect(await checkHumanCaller(request({ headers: phone }), viaProxy)).toEqual({ ok: true });
    expect(reads).toBe(1);
    expect([...knownProxies]).toEqual([`${PROXY}:${PROXY}`]);
    const noKey = { 'x-forwarded-for': '100.101.1.2' };
    expect(await checkHumanCaller(request({ headers: noKey }), viaProxy)).toEqual({
      ok: false,
      reason: 'remote-unverified',
    });
    const offTailnet = { 'x-forwarded-for': '203.0.113.5', authorization: 'Bearer x' };
    expect(await checkHumanCaller(request({ headers: offTailnet }), viaProxy)).toEqual({
      ok: false,
      reason: 'remote-unverified',
    });
    // Тот же прокси без X-Forwarded-For — локальный вызов: судится как окно, ключ прокси не в счёт.
    expect(await checkHumanCaller(request(), viaProxy)).toEqual({
      ok: false,
      reason: 'device-unverified',
    });
    expect(known.size).toBe(0);
    // Тот же номер у другого процесса (другое время создания) судится заново.
    const reused = { ...viaProxy, readTable: async () => [...TABLE, row(PROXY, 1, 2n)] };
    expect(await checkHumanCaller(request({ headers: phone }), reused)).toEqual({ ok: true });
    expect(reads).toBe(3);
  });
});
