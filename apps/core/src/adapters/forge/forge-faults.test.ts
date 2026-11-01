import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeKind, ForgePort } from '@agentdeck/contracts/core/forge';
import {
  closedPortUrl,
  startStubForge,
  type StubFault,
  type StubForge,
} from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgePort } from './index.ts';

/**
 * P44 для форжа: каждое чтение порта при каждом сбое — 5xx, отказ соединения, зависание дольше
 * срока, мусор вместо JSON, 401 — даёт `unknown` с причиной, никогда «нет» и никогда значение.
 * Запись при сбое — тоже `unknown`: дошла ли она, решает сверка outbox, а не догадка.
 */

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

type FaultName = '5xx' | 'refused' | 'stall' | 'garbage' | '401';
const FAULTS: FaultName[] = ['5xx', 'refused', 'stall', 'garbage', '401'];

const RULE: Record<Exclude<FaultName, 'refused'>, StubFault> = {
  '5xx': { kind: 'status', status: 503 },
  stall: { kind: 'stall' },
  garbage: { kind: 'garbage' },
  '401': { kind: 'status', status: 401 },
};

const READS: [string, (p: ForgePort) => Promise<Fact<unknown>>][] = [
  ['whoAmI', (p) => p.whoAmI()],
  [
    'mrBySourceBranch',
    (p) => p.mrBySourceBranch({ sourceBranch: 'a', createdAfter: 0, author: 'publisher' }),
  ],
  ['mr', (p) => p.mr(1)],
  ['threads', (p) => p.threads(1)],
  ['mergeability', (p) => p.mergeability(1)],
  ['pipelines', (p) => p.pipelines({ sha: 'a'.repeat(40) })],
  ['jobLogTail', (p) => p.jobLogTail('1', 100)],
  ['activitySince', (p) => p.activitySince({ since: 0, refs: ['a'], mrIids: [1] })],
];

const WRITES: [string, (p: ForgePort) => Promise<unknown>][] = [
  [
    'createMr',
    (p) =>
      p.createMr({ sourceBranch: 'a', targetBranch: 'main', title: 't', body: 'b', draft: false }),
  ],
  ['updateMr', (p) => p.updateMr(1, { body: 'b' })],
  ['reply', (p) => p.reply(1, 'x', 'b')],
  ['resolve', (p) => p.resolve(1, 'x')],
];

async function faulted(kind: Exclude<ForgeKind, 'generic'>, fault: FaultName): Promise<ForgePort> {
  let url: string;
  let token = 'any';
  if (fault === 'refused') {
    url = await closedPortUrl();
  } else {
    stub = await startStubForge({ faults: [RULE[fault]] });
    url = stub.url;
    token = stub.tokens.publisher!;
  }
  return createForgePort({
    project: { kind, ref: 'acme/app', baseUrl: url, pushUrl: `${url}/acme/app.git` },
    token,
    fetch: globalThis.fetch,
    timeoutMs: 300,
  });
}

describe.each(['gitlab', 'github'] as const)('forge port %s under faults (P44)', (kind) => {
  it.each(FAULTS)('%s: every read is unknown, never absent', async (fault) => {
    const port = await faulted(kind, fault);
    for (const [name, read] of READS) {
      // Лог задания — текст по природе: «мусор» для него и есть текст, судить нечего.
      if (fault === 'garbage' && name === 'jobLogTail') continue;
      const got = await read(port);
      expect(got, `${name} ${fault}`).toHaveProperty('unknown');
      expect((got as { unknown: string }).unknown).not.toMatch(/stub-access|Bearer/);
    }
  });

  it.each(FAULTS)('%s: every write is unknown, never a value', async (fault) => {
    const port = await faulted(kind, fault);
    for (const [name, write] of WRITES) {
      const got = await write(port);
      expect(got, `${name} ${fault}`).toHaveProperty('unknown');
    }
  });

  it('no credential: reads and writes are unknown with the reason named', async () => {
    const port = createForgePort({
      project: { kind, ref: 'acme/app', baseUrl: 'http://127.0.0.1:9', pushUrl: 'x' },
      token: null,
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    expect(await port.whoAmI()).toEqual({ unknown: `GET /user: no ${kind} credential` });
    expect(
      await port.createMr({
        sourceBranch: 'a',
        targetBranch: 'b',
        title: 't',
        body: '',
        draft: false,
      }),
    ).toHaveProperty('unknown');
  });
});
