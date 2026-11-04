import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { verifySignature } from '../../../../server/src/domains/phone-signing/verify.ts';
import { keyFromSeed, type PhoneKey } from '../../shared/api/signing/signing';
import { EMPTY_CARD } from './queue';
import { answerAsk } from './answerAsk';

/**
 * Вопрос права задачи ядра во «Вопросах» телефона (этап 10, G9). Ход чата идёт задачей ядра, и
 * его карточка права — вопрос ядра: маршрут прогона панели (`permission-decision`) отвечает на
 * неё отказом `core_permit_browser_only`, потому что ответ ядру `answer` — human-strict. Телефон
 * отвечает сам: грант и ответ — командами ядра (`/api/core/commands`), подписанными ключом
 * телефона в `proof.signature`. Настоящие: план отправки, отправка карточки, сборка команд,
 * подпись и HTTP-клиент; подменены сеть (fetch), запись пары, SecureStore и `expo-crypto`.
 * Подпись проверяет настоящий проверяющий панели над адресом ядра `POST /v1/commands` — тот же
 * текст подписи ядро судит своим (`apps/core/src/policy/authority/device-signature.ts`; вектор
 * закреплён с обеих сторон — `coreCommand.test.ts` и тест ядра `commands.phone-permit.test.ts`).
 */

const holder = vi.hoisted(() => ({ key: undefined as PhoneKey | undefined, nonce: 0 }));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) % 256),
}));
vi.mock('../../shared/api/connection', () => ({
  currentConnection: () => ({ url: 'http://panel', token: 'phone-token' }),
  activePanel: () => ({ id: 'p', machineId: 'panel-1' }),
}));
vi.mock('../../shared/api/signing/keyStore', () => ({
  loadKey: async () => holder.key,
  freshNonce: () => `nonce-${++holder.nonce}`,
}));
vi.mock('../../shared/api/server-message', () => ({ serverMessage: () => '' }));
vi.mock('../../shared/config/i18n', () => ({
  dict: () => ({
    api: {
      notConfigured: 'no url',
      silent: 'silent',
      unreachable: 'unreachable',
      tokenRejected: 't',
    },
    run: { answered: (status: number) => `status ${status}` },
  }),
}));

const { api } = await import('../../shared/api/client');
const { decideCorePermit } = await import('../../entities/core-task');
const { planSubmissions } = await import('./planSubmissions');
const { submitAll } = await import('./submitAll');

const KEY = keyFromSeed(Uint8Array.from({ length: 32 }, (_, index) => (index * 7) % 256));

const T = {
  coreTask: {
    noKey: 'NO-KEY',
    permitNoGrant: 'NO-GRANT',
    refused: (code: string) => `REFUSED ${code}`,
  },
} as Parameters<typeof decideCorePermit>[0];

const coreAsk = (over: Partial<NonNullable<CoreAsk['core']>> = {}): CoreAsk => ({
  kind: 'permission',
  key: 'p:ask-1',
  toolUseId: 'ask-1',
  toolName: 'core-permit',
  input: { question: 'The step needs a grant to edit migrations/1.sql (Edit)' },
  askedAt: '2026-11-02T10:00:00.000Z',
  core: {
    taskId: 'task-1',
    askId: 'ask-1',
    point: 5,
    options: ['grant', 'refuse'],
    project: 'r1',
    globs: ['migrations/1.sql'],
    ...over,
  },
});
type CoreAsk = Extract<InboxAsk, { kind: 'permission' }>;

interface Sent {
  url: string;
  body: {
    kind: string;
    target: unknown;
    fields: unknown;
    cmdId: string;
    proof: { signature?: string };
  };
}

const sent = (): Sent[] =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as RequestInit).body)) as Sent['body'],
  }));

/** Подпись команды — как её проверит судья над адресом ядра: тело без `proof`. */
const verified = (body: Sent['body']) => {
  const { proof, ...signed } = body;
  return verifySignature(
    { route: 'POST /v1/commands', params: {}, body: signed, header: proof.signature },
    {
      machineId: 'panel-1',
      now: Date.now(),
      devices: [{ id: KEY.deviceId, label: 'p', publicKey: KEY.publicKey, boundAt: '' }],
    },
  );
};

async function answer(ask: CoreAsk, behavior: 'allow' | 'deny') {
  const plan = planSubmissions(
    { runKey: 'run-1' },
    [ask],
    answerAsk(EMPTY_CARD, ask.key, {
      kind: 'permission',
      behavior,
    }),
  );
  return submitAll(plan, {
    post: (path, body) => api.post(path, body),
    sendMessage: vi.fn(),
    sendCore: (card, choice) => decideCorePermit(T, card, choice),
  });
}

beforeEach(() => {
  holder.key = KEY;
  holder.nonce = 0;
  fetchMock.mockReset();
  // Сервер панели: маршрут прогона на вопрос ядра — названный отказ; ядро за прокладкой — принято.
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/permission-decision')) {
      return new Response(
        JSON.stringify({
          error: 'core_permit_browser_only',
          messageCode: 'core-permit-browser-only',
        }),
        { status: 409 },
      );
    }
    return new Response(JSON.stringify({ status: 'applied', seq: 1 }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('phone inbox: a chat core permit card is answered as a signed core command', () => {
  it('allow on a point-5 ask → grant then answer "grant", both device-signed, never the run route', async () => {
    const outcome = await answer(coreAsk(), 'allow');
    expect(outcome).toEqual({ sentKeys: ['p:ask-1'] });
    const calls = sent();
    expect(calls.map((c) => c.url)).toEqual([
      'http://panel/api/core/commands',
      'http://panel/api/core/commands',
    ]);
    expect(calls.map((c) => [c.body.kind, c.body.target, c.body.fields])).toEqual([
      [
        'grant',
        { taskId: 'task-1' },
        { project: 'r1', globs: ['migrations/1.sql'], ops: ['edit'] },
      ],
      ['answer', { taskId: 'task-1' }, { askId: 'ask-1', answer: 'grant' }],
    ]);
    expect(calls.map((c) => verified(c.body))).toEqual([
      { ok: true, deviceId: KEY.deviceId, nonce: 'nonce-1' },
      { ok: true, deviceId: KEY.deviceId, nonce: 'nonce-2' },
    ]);
    // Две команды — два своих номера: ядро судит повтор по `cmdId`.
    expect(new Set(calls.map((c) => c.body.cmdId)).size).toBe(2);
  });

  it('deny → one signed answer "refuse"; a point-3 allow → one signed answer "allow"', async () => {
    await answer(coreAsk(), 'deny');
    expect(sent().map((c) => [c.body.kind, c.body.fields])).toEqual([
      ['answer', { askId: 'ask-1', answer: 'refuse' }],
    ]);
    fetchMock.mockClear();
    await answer(coreAsk({ point: 3, options: ['allow', 'refuse'], globs: [] }), 'allow');
    const calls = sent();
    expect(calls.map((c) => [c.body.kind, c.body.fields])).toEqual([
      ['answer', { askId: 'ask-1', answer: 'allow' }],
    ]);
    expect(verified(calls[0]!.body)).toMatchObject({ ok: true });
  });

  it('no key for this panel → nothing leaves, the card keeps the ask with the reason', async () => {
    holder.key = undefined;
    const outcome = await answer(coreAsk(), 'allow');
    expect(outcome).toEqual({ sentKeys: [], error: 'NO-KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the core refuses → the reason in core words, the ask stays', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: 'signature-invalid', message: 'no' }), { status: 403 }),
    );
    const outcome = await answer(coreAsk(), 'allow');
    expect(outcome).toEqual({ sentKeys: [], error: 'REFUSED signature-invalid' });
  });

  it('a point-5 ask without a repository → no grant to build, nothing leaves', async () => {
    const outcome = await answer(coreAsk({ project: null }), 'allow');
    expect(outcome).toEqual({ sentKeys: [], error: 'NO-GRANT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a plain CLI permission card still goes the run route', async () => {
    const { core: _core, ...plain } = coreAsk();
    await answer({ ...plain, toolName: 'Bash', input: { command: 'ls' } }, 'allow');
    expect(sent().map((c) => c.url)).toEqual(['http://panel/api/chat/run-1/permission-decision']);
  });
});
