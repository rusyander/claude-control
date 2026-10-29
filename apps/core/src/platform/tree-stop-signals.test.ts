import { describe, expect, it } from 'vitest';
import { fakeProcessTable } from './process-identity.ts';
import { stopProcesses, stopTree } from './tree-stop.ts';

describe('F-28 tree stop — signals go only to identity-verified processes', () => {
  it('F-28 a target whose pid now belongs to a stranger (other start) gets no signal at all', async () => {
    const table = fakeProcessTable([
      { pid: 100, ppid: 1, start: 's1', startMs: 1000 },
      { pid: 200, ppid: 1, start: 'new', startMs: 5000 },
    ]);
    const sent: string[] = [];
    await stopProcesses(
      [
        { pid: 100, start: 's1' },
        { pid: 200, start: 'old' },
      ],
      { graceMs: 0, killWaitMs: 0 },
      {
        os: 'linux',
        source: table,
        pollMs: 1,
        signal: (pid, name) => {
          sent.push(`${pid}:${name}`);
          if (pid === 100) table.set([{ pid: 200, ppid: 1, start: 'new', startMs: 5000 }]);
        },
      },
    );
    expect(sent).toEqual(['100:SIGTERM']);
  });

  it('F-28 group signal: a root whose pid was reused is never signalled as a group', async () => {
    const table = fakeProcessTable([
      { pid: 300, ppid: 1, start: 'stranger', startMs: 9000 },
      { pid: 301, ppid: 1, start: 'kid', startMs: 2000 },
    ]);
    const sent: string[] = [];
    await stopTree(
      { pid: 300, start: 'root-old' },
      { graceMs: 0, killWaitMs: 0, group: true, known: [{ pid: 301, start: 'kid' }] },
      {
        os: 'linux',
        source: table,
        pollMs: 1,
        signal: (pid, name) => {
          sent.push(`${pid}:${name}`);
          if (pid === 301) table.set([{ pid: 300, ppid: 1, start: 'stranger', startMs: 9000 }]);
        },
      },
    );
    expect(sent.some((s) => s.startsWith('-300:'))).toBe(false);
    expect(sent).toContain('301:SIGTERM');
  });

  it('F-28 group signal goes out when the root identity is verified alive', async () => {
    const table = fakeProcessTable([{ pid: 400, ppid: 1, start: 'r', startMs: 1000 }]);
    const sent: string[] = [];
    await stopTree(
      { pid: 400, start: 'r' },
      { graceMs: 0, killWaitMs: 0, group: true },
      {
        os: 'linux',
        source: table,
        pollMs: 1,
        signal: (pid, name) => {
          sent.push(`${pid}:${name}`);
          table.set([]);
        },
      },
    );
    expect(sent[0]).toBe('-400:SIGTERM');
  });
});
