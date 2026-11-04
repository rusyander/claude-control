import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent, SessionSpec } from '../adapter.types.ts';
import {
  EventTap,
  HOOK_LOG,
  liveRoot,
  liveSpec,
  livePin,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import {
  fakeGit,
  readMarker,
  realCoreHook,
  startFakeCore,
  type FakeCore,
} from '../conformance/__fixtures__/p81-stand.ts';
import { withBinFirst } from '../conformance/__fixtures__/rpc-replay.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import { createCodexAdapter, CODEX_CHANNELS } from './codex.ts';

/**
 * Живой Codex над заглушкой модели (ключи не тратятся), P81: `git push` не исполняется ни в одном
 * режиме права переходника. Хук ядра — настоящий (`mcp/hook.ts` через команду дороги сессии),
 * ядро за ним — подставной HTTP (внешняя граница): `git push` он отказывает, прочее разрешает.
 * `git` — подставной файл в PATH сеанса, пишет свои аргументы в метку: `git status` в метке —
 * доказательство, что вызов вообще доходит до команды (проверка не пуста); `push` — утечка.
 * Второй замок (правила запуска) проверяется хуком, который разрешает всё.
 */

const present = hasCli(codexRunFacts.binary.command);
const A = '11111111-1111-4111-8111-111111111111';
let live: LiveRoot;
let stub: StubModel;
let core: FakeCore;

const turnEnded = (e: AdapterEvent): boolean => e.type === 'turn.ended';

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('codex-p81-');
  core = await startFakeCore();
  // Модель: сначала `git status`, затем `git push`, затем текст.
  stub = await startStubModel({
    script: (ctx) => {
      const raw = ctx.request.raw;
      const outputs = (raw.match(/function_call_output/g) ?? []).length;
      if (outputs === 0) return { tool: { name: 'exec_command', args: { cmd: 'git status' } } };
      if (outputs === 1) {
        return { tool: { name: 'exec_command', args: { cmd: 'git push origin main' } } };
      }
      return 'P81_DONE';
    },
  });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await core?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

interface Mode {
  name: string;
  over: (spec: SessionSpec) => Partial<SessionSpec>;
  /** Хук: настоящий хук ядра или подставной, разрешающий всё (проверка второго замка). */
  hook: 'core' | 'allow-all';
  /** Вопросы о праве в потоке решает ядро — тест отвечает за судью: всё, кроме публикации. */
  answer: boolean;
  /** Разрешённый `git status` обязан дойти до подставного git: иначе проверка пуста. */
  positive?: true;
}

const MODES: Mode[] = [
  {
    name: 'write session, core answers asks',
    over: () => ({}),
    hook: 'core',
    answer: true,
    positive: true,
  },
  {
    name: 'write session, no permit answerer (asks declined in place)',
    over: () => ({ permitServer: undefined }),
    hook: 'core',
    answer: false,
  },
  {
    name: 'read-only session',
    over: (spec) => ({ deny: { ...spec.deny, tools: [...READ_ONLY_DENIED] } }),
    hook: 'core',
    answer: true,
  },
  {
    name: 'execpolicy backstop: the hook allows everything',
    over: () => ({}),
    hook: 'allow-all',
    answer: true,
    positive: true,
  },
];

async function runMode(mode: Mode, index: number) {
  const marker = join(live.root, `git-${index}.log`);
  const bin = join(live.root, `fakebin-${index}`);
  fakeGit(bin, marker);
  const base = liveSpec(live);
  const hook =
    mode.hook === 'core' ? realCoreHook(base.dir) : `${process.execPath} ${HOOK_LOG} core`;
  const spec: SessionSpec = {
    ...base,
    coreHook: hook,
    permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    endpoint: {
      channel: CODEX_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'openai-responses',
        model: 'stub-model',
        key: 'stub-key',
      },
    },
    env: { pin: withBinFirst(livePin(live), bin) },
    core: { ...base.core, coreUrl: core.url },
  };
  const final: SessionSpec = { ...spec, ...mode.over(spec) };
  // Режим без отвечающего снимает поле целиком: `permitServer: undefined` — тоже «нет».
  if (final.permitServer === undefined) delete final.permitServer;
  const adapter = createCodexAdapter({ pollMs: 20 });
  const launched = await adapter.launch(final);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'run the two commands', A);
    for (;;) {
      const ev = await tap.until((e) => e.type === 'permit.request' || turnEnded(e), 120_000);
      if (ev.type === 'turn.ended') break;
      if (ev.type !== 'permit.request') continue;
      const read = adapter.permitCodec.read(ev.raw);
      const ask = read ? adapter.mapPermission(read.call) : null;
      const allow = mode.answer && ask !== null && !(ask.argv ?? []).includes('push');
      await adapter.answerPermit!(
        launched.handle,
        ev.requestId,
        adapter.permitCodec.render(
          allow ? { allow: true, input: read!.call.input } : { allow: false, message: 'no' },
        ),
      );
    }
  } finally {
    await adapter.stop(launched.handle, 'tree');
  }
  return {
    seen: tap.seen,
    marker: readMarker(marker),
    home: join(final.dir, 'codex-home'),
    executed: readFileSync(join(launched.handle.dir, 'stdout.log'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"item/completed"') && l.includes('commandExecution')),
  };
}

describe.skipIf(!present)(
  'codex adapter on the real CLI — P81 git push refused in every mode',
  () => {
    it.each(MODES.map((m, i) => [m.name, m, i] as const))(
      '%s',
      async (_name, mode, index) => {
        core.calls.length = 0;
        const got = await runMode(mode, index);
        const types = got.seen.map((e) => e.type).join(',');
        expect(
          got.seen.find((e) => e.type === 'turn.ended'),
          types,
        ).toMatchObject({
          attribution: A,
          isError: false,
          text: 'P81_DONE',
        });
        if (process.env.P81_DIAG) {
          appendFileSync(
            process.env.P81_DIAG,
            `[p81] ${mode.name}: marker=${JSON.stringify(got.marker)} hook=${JSON.stringify(core.calls)} events=${types} executed=${got.executed.join(' | ').slice(0, 1500)}\n`,
          );
        }
        if (mode.positive) expect(got.marker, types).toMatch(/status/);
        // Публикация не исполнилась ни разу.
        expect(got.marker, types).not.toMatch(/push/);
        // Хук ядра видел обе команды словами CLI (`Bash` + внутренняя команда).
        if (mode.hook === 'core') {
          expect(core.calls.map((c) => c.tool)).toContain('Bash');
          expect(core.calls.some((c) => /git push/.test(c.command))).toBe(true);
        }
        // Сбой хука (fail-open у Codex) не случился: событие протокола о нём не издано.
        expect(
          got.seen.filter((e) => e.type === 'error' && /core hook failed/.test(e.detail)),
        ).toEqual([]);
        // Дом сеанса — свой: конфиг, хуки и правила лежат там, дом человека не тронут.
        expect(existsSync(join(got.home, 'hooks.json'))).toBe(true);
        expect(readFileSync(join(got.home, 'rules', 'default.rules'), 'utf8')).toMatch(
          /"git", "push"/,
        );
      },
      240_000,
    );
  },
);
