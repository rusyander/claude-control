/**
 * Набор случаев (`conformance.cases.ts`) на каждом протоколе: заглушка по настоящему
 * HTTP, ответ разбирает строгий клиент протокола из `clients/` — независимый от кода
 * пакета оракул, написанный по опубликованным форматам. Заглушка поднята с
 * наблюдателем `route`: каждый случай заодно доказывает, что наблюдатель не мешает.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  DIALECT_IDS,
  startStubModel,
  type DialectId,
  type RouteRequest,
  type Step,
} from './index.mjs';
import { EXTENDED_CAPS, casesFor, type Case, type Harness } from './conformance.cases.ts';
import { call } from './clients/call.ts';

let harness: Harness;
let next: Step = { text: 'unset' };

beforeAll(async () => {
  const routed: RouteRequest[] = [];
  const stub = await startStubModel({
    script: () => next,
    route: (request) => {
      routed.push(request);
      return undefined;
    },
  });
  harness = { stub, routed };
});
afterAll(() => harness.stub.close());

const run = (dialect: DialectId, cases: Case[]) =>
  it.each(cases.map((c) => [`${c.cap}: ${c.name}`, c] as const))('%s', async (_name, c) => {
    next = c.step;
    const controller = new AbortController();
    const [outcome] = await Promise.all([
      call(harness.stub.baseUrl, dialect, c.request, controller.signal),
      c.during?.(harness, () => controller.abort()),
    ]);
    c.check(outcome, dialect, harness);
  });

describe.each(DIALECT_IDS)('conformance %s', (dialect) => {
  run(
    dialect,
    casesFor(dialect).filter((c) => !EXTENDED_CAPS.has(c.cap)),
  );
});

describe('extended caps', () => {
  describe.each(DIALECT_IDS)('%s', (dialect) => {
    run(
      dialect,
      casesFor(dialect).filter((c) => EXTENDED_CAPS.has(c.cap)),
    );
  });
});
