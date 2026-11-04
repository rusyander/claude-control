import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/platform-layers';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { coreGatewayRouteId } from '../platform/routing/core-contour.ts';
import { coreHelperAsk } from '../assistant/assistant.ts';
import { createForeignCarry, type KitExtras } from '../chat/core-foreign/foreign-carry.ts';
import { createCoreAskPort } from './core-ask.ts';
import { helperCarryOf } from './helper-carry.ts';
import { startFakeCore, type FakeCore } from './__fixtures__/fake-core.ts';

/**
 * Набор панели окну помощника (этап 10, G13): прежнее окно давало чужому CLI `route.kit.env`
 * (HEAD `assistant-route.ts`), Claude — ничего. Перенос — тот же `createForeignCarry`, что у
 * разговора чужого CLI; набор подменён на границе (`kitExtras`), клиент ядра и заглушка ядра на
 * настоящем HTTP идут своим путём — тело `/v1/ask` проверено схемой ядра (`askBodySchema`).
 */

let appData: string;
let store: AppStore;
let core: FakeCore | undefined;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'helper-carry-'));
  store = new AppStore(appData);
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  rmSync(appData, { recursive: true, force: true });
});

const QWEN_KIT = join(tmpdir(), 'agentdeck-kit', 'qwen-home');

function carryWith(extras: (input: { provider: string; local: boolean }) => KitExtras) {
  const calls: { provider: string; local: boolean }[] = [];
  const carry = helperCarryOf(
    createForeignCarry({
      testsNote: () => 'строка о тестах — окну помощника не идёт',
      kitExtras: (input) => {
        calls.push({ provider: input.provider, local: input.local });
        return extras(input);
      },
    }),
  );
  return { carry, calls };
}

async function askVia(carry: ReturnType<typeof helperCarryOf>) {
  core = await startFakeCore({
    turn: async ({ emit }) => {
      emit({ kind: 'assistant-text', data: { text: 'ок' } });
      emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
    },
  });
  const port = createCoreAskPort(() => core!.home, core.identity);
  return coreHelperAsk(port, store, appData, carry)('вопрос окна', [], 30_000);
}

describe('набор панели окну помощника (G13)', () => {
  it('qwen: дом набора — именем в fields.session.env и значением в env тела, метки тестов нет', async () => {
    store.updateSettings({ provider: 'qwen' });
    const { carry, calls } = carryWith(() => ({
      args: [],
      env: { QWEN_HOME: QWEN_KIT, AGENTDECK_KIT_VARIANT: 'ours' },
    }));
    const answer = await askVia(carry);
    expect(answer).toEqual({ ok: true, text: 'ок' });
    expect(calls).toEqual([{ provider: 'qwen', local: false }]);
    expect(core!.asks[0]!.session).toEqual({ env: ['AGENTDECK_KIT_VARIANT', 'QWEN_HOME'] });
    expect(core!.askEnvs[0]).toEqual({ AGENTDECK_KIT_VARIANT: 'ours', QWEN_HOME: QWEN_KIT });
    // Строка о тестах — только у разговора в каталоге проекта; у окна каталога нет.
    expect(JSON.stringify(core!.asks[0])).not.toContain('строка о тестах');
  });

  it('codex: правила набора — дописка сеанса, переменных нет', async () => {
    store.updateSettings({ provider: 'codex' });
    const { carry } = carryWith(() => ({ args: [], env: {}, append: 'Правила набора Codex' }));
    await askVia(carry);
    expect(core!.asks[0]!.session).toEqual({ append: 'Правила набора Codex' });
    expect(core!.askEnvs[0]).toBeUndefined();
  });

  it('claude: набора нет, как у прежнего окна — набор даже не собирается', async () => {
    store.updateSettings({ provider: 'claude' });
    const { carry, calls } = carryWith(() => ({ args: [], env: { QWEN_HOME: QWEN_KIT } }));
    await askVia(carry);
    expect(calls).toEqual([]);
    expect(core!.asks[0]!.session).toBeUndefined();
    expect(core!.askEnvs[0]).toBeUndefined();
  });

  it('вариант набора — по маршрутам хода: шлюз локального контура → local', () => {
    const { carry, calls } = carryWith(() => ({ args: [], env: {} }));
    const routes = [
      {
        adapter: 'qwen',
        route: { kind: 'gateway' as const, id: coreGatewayRouteId(LOCAL_PLATFORM_ID) },
        modelPattern: '*',
      },
    ];
    expect(carry({ cli: 'qwen', routes })).toEqual({ ok: true });
    expect(calls).toEqual([{ provider: 'qwen', local: true }]);
  });

  it('то, чего вопрос не берёт (плагины набора), — отказ по имени, а не ход без части набора', async () => {
    store.updateSettings({ provider: 'qwen' });
    const plugin = join(tmpdir(), 'agentdeck-kit', 'plugin');
    const { carry } = carryWith(() => ({ args: ['--plugin-dir', plugin], env: {} }));
    expect(carry({ cli: 'qwen', routes: undefined })).toEqual({
      ok: false,
      reason:
        'the panel kit for qwen needs plugins, a helper question takes only rules text and environment',
    });
    const answer = await askVia(carry);
    expect(answer).toMatchObject({ ok: false, messageCode: 'assistant-route-refused' });
    expect(core!.asks).toEqual([]);
  });

  it('набор не собрался — отказ окну с причиной набора, ядру вопроса нет', async () => {
    store.updateSettings({ provider: 'qwen' });
    const { carry } = carryWith(() => {
      throw new Error('kit dir unreadable');
    });
    const answer = await askVia(carry);
    expect(answer).toMatchObject({ ok: false, messageCode: 'assistant-route-refused' });
    expect(JSON.stringify(answer)).toContain('kit dir unreadable');
    expect(core!.asks).toEqual([]);
  });
});
