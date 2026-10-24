import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deferredIdOf,
  deferredIdsIn,
  withoutDeferredWaitLines,
} from '@agentdeck/contracts/deferred-asks';
import {
  DEFERRED_ASKS_FILE,
  DeferredAsks,
  allowMainCopyPrompt,
  allowResumePrompt,
  denyResumePrompt,
  alreadyQueuedDenial,
  callHash,
  deferralDenial,
  deferredScopeOf,
  deferredView,
  humanRefusedDenial,
} from './deferred-asks.ts';

const GROUP = { kind: 'group' as const, parentChatId: 'parent', groupIndex: 1 };
const OTHER_GROUP = { kind: 'group' as const, parentChatId: 'parent', groupIndex: 2 };
const DROP = { command: 'psql -c "DROP TABLE users"', description: 'drop users' };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function clock(start = Date.parse('2026-10-23T10:00:00Z')) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function ask(store: DeferredAsks, input: unknown = DROP, scope = GROUP) {
  return store.ask({
    scope,
    runKeys: ['new-1', 'sess-1'],
    toolName: 'Bash',
    input,
    toolUseId: 'tu-1',
    reason: 'row database',
  });
}

describe('deferred-asks › отпечаток вызова', () => {
  it('порядок ключей и подпись не меняют отпечатка, команда — меняет', () => {
    const base = callHash('Bash', { command: 'rm -rf ./a', description: 'x', timeout: 1 });
    expect(callHash('Bash', { timeout: 5, command: 'rm -rf ./a', description: 'другая' })).toBe(
      base,
    );
    expect(callHash('Bash', { command: 'rm -rf ./a ./b' })).not.toBe(base);
    expect(callHash('Bash', { command: 'rm -rf  ./a' })).not.toBe(base);
    expect(callHash('Bash', { command: 'rm -rf ./a', dangerouslyDisableSandbox: true })).not.toBe(
      base,
    );
    expect(callHash('Write', { command: 'rm -rf ./a' })).not.toBe(base);
    // У не-Bash `timeout` — не косметика: это вход инструмента.
    expect(callHash('mcp__db__query', { sql: 'x', timeout: 1 })).not.toBe(
      callHash('mcp__db__query', { sql: 'x', timeout: 2 }),
    );
  });
});

describe('deferred-asks › запись', () => {
  it('новый вызов — D-1, повтор того же — тот же D-1 без новой записи', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now });
    const first = ask(store);
    expect(first.kind).toBe('created');
    expect(first.record.id).toBe('D-1');
    const again = ask(store, { ...DROP, description: 'другая подпись' });
    expect(again.kind).toBe('queued');
    expect(again.record.id).toBe('D-1');
    expect(again.record.retries).toBe(1);
    expect(store.all()).toHaveLength(1);
    // Другая группа — своя запись.
    expect(ask(store, DROP, OTHER_GROUP).record.id).toBe('D-2');
  });

  it('после отказа человека повтор — «отказано», не новая запись', () => {
    const store = new DeferredAsks({ now: clock().now });
    ask(store);
    expect(
      store.decide('D-1', { behavior: 'deny', message: 'не трогай', via: 'web' })?.changed,
    ).toBe(true);
    const retry = ask(store);
    expect(retry.kind).toBe('refused');
    expect(retry.record.message).toBe('не трогай');
    expect(store.all()).toHaveLength(1);
  });

  it('разрешение — один раз, только в своей группе и только тот же вызов', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now });
    ask(store);
    store.decide('D-1', { behavior: 'allow', via: 'mobile' });
    expect(store.consume(OTHER_GROUP, 'Bash', DROP)).toBeUndefined();
    expect(
      store.consume(GROUP, 'Bash', { command: 'psql -c "DROP TABLE users;"' }),
    ).toBeUndefined();
    expect(store.consume(GROUP, 'Bash', { ...DROP, description: 'иначе' })?.id).toBe('D-1');
    expect(store.consume(GROUP, 'Bash', DROP)).toBeUndefined();
    expect(store.get('D-1')?.state).toBe('consumed');
  });

  it('разрешение истекает через 2 ч; истёкшее человек вправе разрешить заново', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now });
    ask(store);
    store.decide('D-1', { behavior: 'allow', via: 'web' });
    time.advance(2 * 3_600_000 + 1);
    expect(store.consume(GROUP, 'Bash', DROP)).toBeUndefined();
    expect(store.get('D-1')?.state).toBe('expired');
    const again = store.decide('D-1', { behavior: 'allow', via: 'web' });
    expect(again?.changed).toBe(true);
    expect(store.consume(GROUP, 'Bash', DROP)?.id).toBe('D-1');
  });

  it('ожидание истекает по сроку настройки; повторный ответ на решённое ничего не меняет', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now, ttlMs: () => 60_000 });
    ask(store);
    time.advance(60_001);
    expect(store.waiting(GROUP)).toHaveLength(0);
    expect(store.get('D-1')?.state).toBe('expired');
    store.decide('D-1', { behavior: 'deny', via: 'web' });
    const twice = store.decide('D-1', { behavior: 'allow', via: 'web' });
    expect(twice).toEqual({ record: expect.objectContaining({ state: 'denied' }), changed: false });
  });

  it('законченная запись видна сутки, потом убрана; номер не повторяется', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now });
    ask(store);
    store.decide('D-1', { behavior: 'deny', via: 'web' });
    time.advance(86_400_001);
    expect(store.all()).toHaveLength(0);
    expect(ask(store).record.id).toBe('D-2');
  });

  it('отзыв при отмене плана снимает ждущие и неиспользованные', () => {
    const store = new DeferredAsks({ now: clock().now });
    ask(store);
    ask(store, { command: 'other' });
    store.decide('D-2', { behavior: 'allow', via: 'web' });
    const gone = store.withdraw(
      (scope) => scope.kind === 'group' && scope.parentChatId === 'parent',
    );
    expect(gone.map((record) => record.id)).toEqual(['D-1', 'D-2']);
    expect(store.consume(GROUP, 'Bash', { command: 'other' })).toBeUndefined();
  });

  it('файл переживает перезапуск: ждущие, разрешения и счёт номеров', () => {
    dir = mkdtempSync(join(tmpdir(), 'deferred-'));
    const file = join(dir, DEFERRED_ASKS_FILE);
    const time = clock();
    const before = new DeferredAsks({ file, now: time.now });
    ask(before);
    ask(before, { command: 'two' });
    before.decide('D-2', { behavior: 'allow', via: 'web' });
    const after = new DeferredAsks({ file, now: time.now });
    expect(after.waiting(GROUP).map((record) => record.id)).toEqual(['D-1']);
    expect(after.unresumed().map((record) => record.id)).toEqual(['D-2']);
    after.markResumed('D-2');
    expect(new DeferredAsks({ file, now: time.now }).unresumed()).toEqual([]);
    expect(after.consume(GROUP, 'Bash', { command: 'two' })?.id).toBe('D-2');
    expect(ask(after, { command: 'three' }).record.id).toBe('D-3');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; next: number };
    expect(saved).toMatchObject({ version: 2, next: 4 });
  });

  it('битый файл — пустой список, сервер не падает', () => {
    dir = mkdtempSync(join(tmpdir(), 'deferred-'));
    const file = join(dir, DEFERRED_ASKS_FILE);
    writeFileSync(file, '{not json');
    expect(new DeferredAsks({ file }).all()).toEqual([]);
  });

  it('слушатели узнают о новой записи и о решении; повтор не будит их', () => {
    const store = new DeferredAsks({ now: clock().now });
    const seen: string[] = [];
    store.onCreated((record) => seen.push(`new ${record.id}`));
    store.onDecided((record) => seen.push(`${record.state} ${record.id}`));
    ask(store);
    ask(store);
    store.decide('D-1', { behavior: 'allow', via: 'telegram' });
    store.decide('D-1', { behavior: 'allow', via: 'telegram' });
    expect(seen).toEqual(['new D-1', 'allowed D-1']);
  });

  it('вид для человека — без входа целиком, секреты под маской', () => {
    const store = new DeferredAsks({ now: clock().now });
    const { record } = ask(store, {
      command:
        'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" x',
    });
    const view = deferredView(record);
    expect(view).not.toHaveProperty('input');
    expect(view.summary).not.toContain('abcdefghijklmnop');
    expect(view.chatId).toBe('sess-1');
  });
});

describe('deferred-asks › тексты и метка', () => {
  it('все три отказа несут метку с номером, продолжение — вход знак в знак', () => {
    expect(deferredIdOf(deferralDenial('D-7', 'row database'))).toBe('D-7');
    expect(deferredIdOf(alreadyQueuedDenial('D-7'))).toBe('D-7');
    expect(deferredIdOf(humanRefusedDenial('D-7', 'нет'))).toBe('D-7');
    expect(deferredIdOf('Exit code 1 agentdeck(deferred D-7)')).toBeUndefined();
    const prompt = allowResumePrompt({ id: 'D-7', toolName: 'Bash', input: DROP });
    expect(prompt).toContain('psql -c "DROP TABLE users"');
    expect(prompt).not.toContain('drop users');
  });

  it('каждое продолжение после решения велит снять черновик, когда ждать нечего (RF-DL-11)', () => {
    const record = { id: 'D-7', toolName: 'Bash', input: DROP };
    for (const prompt of [
      allowResumePrompt(record),
      allowMainCopyPrompt({ id: 'D-7', input: { path: '/repo' } }),
      denyResumePrompt(record),
    ]) {
      expect(prompt).toContain('take the MR out of draft');
    }
  });

  it('строки «Waiting for the human: D-n» вырезаются, прочий текст остаётся', () => {
    const text =
      'Done with the rest.\n\nWaiting for the human: D-7 — migrates the table\n- Waiting for the human: D-8 — ok';
    expect(withoutDeferredWaitLines(text)).toBe('Done with the rest.');
    expect(deferredIdsIn(text)).toEqual(['D-7', 'D-8']);
    expect(deferredIdsIn('PD-7 and D-70x')).toEqual([]);
  });
});

describe('deferred-asks › чьё это', () => {
  it('связь с группой — группа, иначе ключи чата', () => {
    const links: Record<string, { parentChatId?: string; groupIndex?: number }> = {
      child: { parentChatId: 'parent', groupIndex: 3 },
      manual: { parentChatId: 'parent' },
    };
    const linkOf = (key: string) => links[key];
    expect(deferredScopeOf(linkOf, ['new-1', 'child'])).toEqual({
      kind: 'group',
      parentChatId: 'parent',
      groupIndex: 3,
    });
    expect(deferredScopeOf(linkOf, ['manual', undefined, 'manual'])).toEqual({
      kind: 'chat',
      chatKeys: ['manual'],
    });
  });
});

describe('deferred-asks › «сказано» на диске (RF-DL-04/06)', () => {
  it('новый исход снимает «сказано»: решение, истечение срока, повтор после срока', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now, ttlMs: () => 60_000 });
    ask(store);
    store.markTold(['D-1']);
    expect(store.get('D-1')?.toldAt).toBeTruthy();
    time.advance(60_001);
    store.sweep();
    expect(store.get('D-1')?.state).toBe('expired');
    expect(store.get('D-1')?.toldAt).toBeUndefined();
    store.markTold(['D-1']);
    // Тот же вызов после срока — прежний номер снова ждёт, слово о нём ещё впереди.
    expect(ask(store).record.id).toBe('D-1');
    expect(store.get('D-1')?.state).toBe('waiting');
    expect(store.get('D-1')?.toldAt).toBeUndefined();
    store.markTold(['D-1']);
    store.decide('D-1', { behavior: 'deny', via: 'web' });
    expect(store.get('D-1')?.toldAt).toBeUndefined();
  });

  it('слово сложено о прежнем исходе — запись, сменившая исход, не помечается', () => {
    const store = new DeferredAsks({ now: clock().now });
    ask(store);
    const states = new Map([['D-1', 'waiting' as const]]);
    store.decide('D-1', { behavior: 'allow', via: 'web' });
    store.markTold(['D-1'], states);
    expect(store.get('D-1')?.toldAt).toBeUndefined();
    store.markTold(['D-1'], new Map([['D-1', 'allowed' as const]]));
    expect(store.get('D-1')?.toldAt).toBeTruthy();
    expect(store.get('D-1')?.resumedAt).toBeTruthy();
  });

  it('ответ сразу после срока: решаемая запись истекает молча, соседняя — со словом (RF-DL-15)', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now, ttlMs: () => 60_000 });
    const lapsed: string[] = [];
    store.onExpired((record) => lapsed.push(record.id));
    ask(store);
    ask(store, { command: 'other' });
    time.advance(60_001);
    store.decide('D-1', { behavior: 'allow', via: 'web' });
    expect(store.get('D-1')?.state).toBe('allowed');
    expect(lapsed).toEqual(['D-2']);
  });

  it('файл версии 1: решённое и заведённое считаются сказанными, неподхваченное разрешение — нет', () => {
    dir = mkdtempSync(join(tmpdir(), 'deferred-'));
    const file = join(dir, DEFERRED_ASKS_FILE);
    const base = {
      scope: GROUP,
      runKeys: ['sess-1'],
      toolName: 'Bash',
      input: DROP,
      reason: 'row database',
      askedAt: '2026-10-23T10:00:00.000Z',
      expiresAt: '2026-10-30T10:00:00.000Z',
      retries: 0,
    };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        next: 4,
        records: [
          {
            ...base,
            id: 'D-1',
            hash: 'h1',
            state: 'denied',
            decidedAt: '2026-10-23T10:01:00.000Z',
            closedAt: '2026-10-23T10:01:00.000Z',
          },
          {
            ...base,
            id: 'D-2',
            hash: 'h2',
            state: 'allowed',
            grantUntil: '2099-01-01T00:00:00.000Z',
            resumedAt: '2026-10-23T10:02:00.000Z',
          },
          {
            ...base,
            id: 'D-3',
            hash: 'h3',
            state: 'allowed',
            grantUntil: '2099-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const store = new DeferredAsks({ file, now: clock().now });
    expect(store.get('D-1')?.toldAt).toBe('2026-10-23T10:01:00.000Z');
    expect(store.get('D-2')?.toldAt).toBe('2026-10-23T10:02:00.000Z');
    expect(store.get('D-3')?.toldAt).toBeUndefined();
  });

  it('файла нет, рядом отведённый `.bad-…` — счёт номеров продолжается с него (RF-DL-12, живой T2B)', () => {
    dir = mkdtempSync(join(tmpdir(), 'deferred-'));
    const file = join(dir, DEFERRED_ASKS_FILE);
    writeFileSync(
      `${file}.bad-2026-10-23T10-00-00-000Z`,
      '{"version":2,"next":8,"records":[{"id":"D-7"',
    );
    const store = new DeferredAsks({ file, now: clock().now });
    expect(ask(store).record.id).toBe('D-8');
  });
});

describe('deferred-asks › близнецы вызова (RF-DL-02)', () => {
  it('карточка решена — ждущий D-n того же вызова закрыт тем же решением, чужая группа не тронута', () => {
    const store = new DeferredAsks({ now: clock().now });
    ask(store);
    ask(store, DROP, OTHER_GROUP);
    const closed = store.cardDecided(GROUP, 'Bash', { ...DROP, description: 'иначе' }, 'allow');
    expect(closed.map((record) => record.id)).toEqual(['D-1']);
    expect(store.get('D-1')).toMatchObject({ state: 'consumed', decidedVia: 'web' });
    expect(store.get('D-1')?.toldAt).toBeTruthy();
    // Разрешения по нему больше нет: поздний «Разрешить» ничего не исполнит.
    expect(store.consume(GROUP, 'Bash', DROP)).toBeUndefined();
    expect(store.decide('D-1', { behavior: 'allow', via: 'web' })?.changed).toBe(false);
    expect(store.get('D-2')?.state).toBe('waiting');
  });

  it('отказ с карточки закрывает близнеца отказом; повтор получает «отказано»', () => {
    const store = new DeferredAsks({ now: clock().now });
    ask(store);
    store.cardDecided(GROUP, 'Bash', DROP, 'deny');
    expect(store.get('D-1')?.state).toBe('denied');
    expect(ask(store).kind).toBe('refused');
  });

  it('близнец решён после показа своей карточки — решение известно; решение до показа — нет', () => {
    const time = clock();
    const store = new DeferredAsks({ now: time.now });
    const shownAt = time.now();
    time.advance(1_000);
    store.cardDecided(GROUP, 'Bash', DROP, 'allow');
    expect(store.twinDecided(GROUP, 'Bash', DROP, shownAt)).toBe('allow');
    expect(store.twinDecided(OTHER_GROUP, 'Bash', DROP, shownAt)).toBeUndefined();
    expect(store.twinDecided(GROUP, 'Bash', { command: 'other' }, shownAt)).toBeUndefined();
    time.advance(1_000);
    // Тот же вызов позже — новый вызов: прежнее решение его не покрывает.
    expect(store.twinDecided(GROUP, 'Bash', DROP, time.now())).toBeUndefined();
  });
});
