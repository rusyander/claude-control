import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_FIELDS,
  COMMAND_KINDS,
  type CommandKind,
} from '@agentdeck/contracts/core/commands';
import { existsSync } from 'node:fs';
import { readJournalLines } from '../journal/read-lines.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { join } from 'node:path';
import { newId } from '../lib/ids/uuidv7.ts';
import {
  DIRECT_PID,
  SESSION_PID,
  startStand,
  TOKENS,
  TRUSTED_HOP_PID,
  type Stand,
} from './__fixtures__/api-harness.ts';
import { FORWARDED_PEER_HEADER } from './auth.ts';

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const journal = (s: Stand) => readJournalLines(join(s.registry.tasksDir, s.taskId), s.taskId).lines;

/** Минимально годные поля вида — чтобы проверить ровно одно лишнее или недостающее поле. */
const VALID_FIELDS: Record<CommandKind, unknown> = {
  launch: {},
  pause: {},
  resume: {},
  cancel: { reason: 'стоп' },
  'set-model': { scope: 'task', scopeId: newId(), model: 'm-1', effort: null },
  'set-cli': { scope: 'task', scopeId: newId(), adapter: 'a-1' },
  'edit-scenario': { scenarioId: 's', version: 1, applyNow: false },
  answer: { askId: newId(), answer: 'да' },
  'approve-split': { splitId: newId() },
  'edit-split': { splitId: newId(), units: [{ name: 'u', ownedPaths: ['src'] }] },
  'fresh-rerun': { scope: 'check', ref: 'c' },
  'publish-now': { unitId: newId() },
  'move-build': { build: 'b' },
  'message-to-step': { stepId: newId(), text: 't' },
  'release-resource': { rid: newId() },
  grant: { project: 'p', globs: ['**'], ops: ['edit'] },
  'clean-remote': { branches: ['b'] },
  'set-route': {
    scope: 'task',
    scopeId: newId(),
    allowedRoutes: [{ adapter: 'a-1', route: { kind: 'stub', id: 's-1' }, modelPattern: '*' }],
  },
};

describe('POST /v1/commands', () => {
  it('P42 per command kind: a missing field and an unknown field are 400, never a default edit; journal untouched', async () => {
    stand = await startStand();
    expect(Object.keys(VALID_FIELDS).sort()).toEqual([...COMMAND_KINDS].sort());
    const before = journal(stand).length;
    for (const kind of COMMAND_KINDS) {
      const valid = VALID_FIELDS[kind] as Record<string, unknown>;
      const extra = await stand.command(stand.envelope(kind, { ...valid, zzz: 1 }));
      expect({ kind, status: extra.status, codes: issueCodes(extra.body) }).toEqual({
        kind,
        status: 400,
        codes: ['unknown-field'],
      });
      const shape = COMMAND_FIELDS[kind].shape as Record<string, unknown>;
      for (const field of Object.keys(shape)) {
        const { [field]: _dropped, ...missing } = valid;
        const res = await stand.command(stand.envelope(kind, missing));
        expect({ kind, field, status: res.status, codes: issueCodes(res.body) }).toEqual({
          kind,
          field,
          status: 400,
          codes: ['missing-field'],
        });
      }
    }
    const envelopeExtra = await stand.command({ ...stand.envelope('launch'), surprise: true });
    expect(envelopeExtra.status).toBe(400);
    const noFields = stand.envelope('launch') as Record<string, unknown>;
    delete noFields.fields;
    expect((await stand.command(noFields)).status).toBe(400);
    expect(journal(stand).length).toBe(before);
  });

  it('P47 the same command twice concurrently → one effect, the same stored outcome', async () => {
    stand = await startStand();
    const { nonce, page } = await stand.nonce();
    const cmd = stand.envelope('launch', {}, { proof: { nonce, page } });
    stand.peer.delayMs = 150;
    const [a, b] = await Promise.all([stand.command(cmd), stand.command(cmd)]);
    expect(a).toEqual(b);
    expect(a.status).toBe(200);
    const again = await stand.command(cmd);
    expect(again.body).toEqual(a.body);
    const lines = journal(stand).filter((l) => l.cmdId === cmd.cmdId);
    expect(lines.map((l) => l.kind)).toEqual([
      'command.received',
      'task.transition',
      'command.applied',
    ]);
  });

  it('P47 across a core restart: received but undecided → decided once on the journaled proof; repeat returns it', async () => {
    stand = await startStand();
    const task = stand.registry.live(stand.taskId);
    if (!task) throw new Error('task not live');
    const cmdId = newId();
    task.append({
      kind: 'command.received',
      actor: 'human:panel',
      cmdId,
      data: {
        kind: 'launch',
        target: { taskId: stand.taskId },
        expectSeq: null,
        fields: {},
        proof: { token: 'core', nonce: 'valid', peer: 'clear', signature: 'absent' },
      },
    });
    const tasksDir = stand.registry.tasksDir;
    await stand.close();
    stand = await startStand(tasksDir);
    stand.taskId = task.taskId;
    // Повтор после перезапуска — без нового числа: решение по доказательству из журнала.
    const cmd = { cmdId, kind: 'launch', target: { taskId: task.taskId }, fields: {}, proof: {} };
    // Обе отправки разом: задача после перезапуска ещё не открыта, первая открывает её по
    // требованию. Гонку двух открытий в одном такте ловит тест реестра (`tasks.test.ts`).
    const [first, second] = await Promise.all([stand.command(cmd), stand.command(cmd)]);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const lines = journal(stand).filter((l) => l.cmdId === cmdId);
    expect(lines.map((l) => l.kind)).toEqual([
      'command.received',
      'task.transition',
      'command.applied',
    ]);
  });

  it('stale expectSeq → 409 with the current state; journaled as rejected', async () => {
    stand = await startStand();
    const { nonce, page } = await stand.nonce();
    const res = await stand.command(
      stand.envelope('launch', {}, { expectSeq: 1, proof: { nonce, page } }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale-seq');
    expect((res.body.state as { seq: number }).seq).toBeGreaterThan(1);
  });

  // Ревью M1: повтор `cmdId` — это повтор ТОЙ ЖЕ команды. Другое тело под тем же `cmdId` не
  // исполняется: ни по доказательству первого тела (принятого до краха), ни как сохранённый исход.
  describe('M1 the same cmdId with a different body is refused', () => {
    async function receivedBeforeCrash(proof: object): Promise<{ cmdId: string; taskId: string }> {
      stand = await startStand();
      const task = stand.registry.live(stand.taskId);
      if (!task) throw new Error('task not live');
      const cmdId = newId();
      task.append({
        kind: 'command.received',
        actor: 'human:panel',
        cmdId,
        data: {
          kind: 'launch',
          target: { taskId: task.taskId },
          expectSeq: null,
          fields: {},
          proof: proof as never,
        },
      });
      const tasksDir = stand.registry.tasksDir;
      await stand.close();
      stand = await startStand(tasksDir);
      stand.taskId = task.taskId;
      return { cmdId, taskId: task.taskId };
    }

    it('pending "launch" (nonce proof) retried as "cancel" → rejected without a write, the cancel never applies, the launch stays pending (F-47)', async () => {
      const { cmdId, taskId } = await receivedBeforeCrash({
        token: 'core',
        nonce: 'valid',
        peer: 'clear',
        signature: 'absent',
      });
      const cancel = { cmdId, kind: 'cancel', target: { taskId }, fields: { reason: 'x' } };
      const res = await stand!.command({ ...cancel, proof: {} });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('cmd-id-reused');
      const kinds = journal(stand!)
        .filter((l) => l.cmdId === cmdId)
        .map((l) => l.kind);
      // Чужое тело не закрывает принятую команду: её законный повтор решится по её доказательству.
      expect(kinds).toEqual(['command.received']);
    });

    it('pending device-signed "launch" retried as strict "publish-now" unsigned → cmd-id-reused, not past authority', async () => {
      const { cmdId, taskId } = await receivedBeforeCrash({
        token: 'core',
        nonce: 'absent',
        peer: 'unknown',
        signature: 'valid',
      });
      const res = await stand!.command({
        cmdId,
        kind: 'publish-now',
        target: { taskId },
        fields: { unitId: newId() },
        proof: {},
      });
      expect(res.body.code).toBe('cmd-id-reused');
    });

    it('decided cmdId retried with a different body → refused, journal untouched; same body in another key order → stored outcome', async () => {
      stand = await startStand();
      const { nonce, page } = await stand.nonce();
      const first = stand.envelope(
        'set-model',
        { scope: 'task', scopeId: newId(), model: 'm-1', effort: null },
        { proof: { nonce, page } },
      );
      const decided = await stand.command(first);
      expect(decided.body.code).toBe('not-implemented');
      const before = journal(stand).length;
      const reordered = {
        ...first,
        fields: Object.fromEntries(Object.entries(first.fields as object).reverse()),
      };
      expect(await stand.command(reordered)).toEqual(decided);
      const other = await stand.command({
        ...first,
        kind: 'set-cli' as const,
        fields: {
          scope: 'task',
          scopeId: newId(),
          adapter: 'a-1',
        },
      });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('cmd-id-reused');
      expect(journal(stand).length).toBe(before);
    });
  });

  it('A a trusted hop that forwards no peer pid is an unknown peer: a strict command needs the device signature', async () => {
    stand = await startStand();
    const s = stand;
    s.peer.direct = TRUSTED_HOP_PID;
    // Звено пересылки без заголовка: настоящий источник не назван — pid самого звена не человек.
    const strict = await s.command(
      s.envelope('publish-now', { unitId: newId() }, { proof: await s.nonce() }),
    );
    expect(strict.body.code).toBe('signature-required');
    // Обычная команда по числу своей страницы проходит суд полномочий (как при любом unknown).
    const ordinary = await s.command(s.envelope('pause', {}, { proof: await s.nonce() }));
    expect(ordinary.body.code).toBe('state-conflict');
    // Подпись устройства доказывает человека и через такое звено.
    const signedCmd = s.envelope('publish-now', { unitId: newId() });
    const signed = await s.command({
      ...signedCmd,
      proof: { signature: s.device.signFor(signedCmd) },
    });
    expect(signed).toMatchObject({ status: 501, body: { code: 'not-implemented' } });
  });

  it('G25 release-resource over HTTP: unknown rid → 404 no-such-resource, a tmpdir → 200 and gone, again → 409 already-released', async () => {
    stand = await startStand();
    const s = stand;
    const signed = async (rid: string) => {
      const cmd = s.envelope('release-resource', { rid });
      return s.command({ ...cmd, proof: { signature: s.device.signFor(cmd) } });
    };
    expect(await signed(newId())).toMatchObject({
      status: 404,
      body: { code: 'no-such-resource' },
    });
    const dir = tempDir('api-release-');
    const rid = newId();
    s.registry.live(s.taskId)!.append({
      kind: 'resource.created',
      actor: 'core',
      data: { rid, kind: 'tmpdir', owner: 'session', release: 'task-end', ref: dir },
    });
    expect((await signed(rid)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect(await signed(rid)).toMatchObject({
      status: 409,
      body: { code: 'already-released' },
    });
  });

  it('P97 P41 attack corpus through the real HTTP path → refused and journaled; honest proofs pass', async () => {
    stand = await startStand();
    const s = stand;
    const launch = async (proof: object, opts: Parameters<Stand['command']>[1] = {}) =>
      s.command(s.envelope('pause', {}, { proof: proof as never }), opts);
    // Честный путь: число своей страницы + пир не из сессии. Пауза из draft — конфликт состояния,
    // а не отказ полномочий: суд полномочий пройден.
    const honest = await s.nonce();
    const second = await s.nonce();
    expect((await launch(honest)).body.code).toBe('state-conflict');
    // Повтор того же числа.
    expect((await launch(honest)).body.code).toBe('nonce-invalid');
    // То же тело под вторым числом, выданным до первой команды, проходит: гасится ровно
    // предъявленное число, а не тело команды и не прочие выданные числа.
    expect((await launch(second)).body.code).toBe('state-conflict');
    // Число чужой загрузки страницы.
    const foreign = await s.nonce();
    expect((await launch({ nonce: foreign.nonce, page: newId() })).body.code).toBe('nonce-invalid');
    // Токен сессии на команде.
    const forged = await launch(await s.nonce(), { token: TOKENS.session });
    expect(forged).toMatchObject({ status: 403, body: { code: 'forged-authority' } });
    // Пир из дерева сессии (Playwright из сессии кликает настоящий интерфейс).
    s.peer.direct = SESSION_PID;
    expect((await launch(await s.nonce())).body.code).toBe('forged-authority');
    // Переслан pid от непроверенного звена.
    s.peer.direct = DIRECT_PID;
    const untrusted = await launch(await s.nonce(), {
      headers: { [FORWARDED_PEER_HEADER]: '1234' },
    });
    expect(untrusted.body.code).toBe('signature-required');
    // Проверенное звено пересылает pid процесса сессии.
    s.peer.direct = TRUSTED_HOP_PID;
    const viaHop = await launch(await s.nonce(), {
      headers: { [FORWARDED_PEER_HEADER]: String(SESSION_PID) },
    });
    expect(viaHop.body.code).toBe('forged-authority');
    // Без токена канала — 401 до журнала.
    s.peer.direct = DIRECT_PID;
    expect((await launch(await s.nonce(), { token: 'nope' })).status).toBe(401);
    // Пир неизвестен: обычная команда по числу проходит, строгая — только подписью устройства.
    s.peer.direct = 'unknown';
    const strictNoSig = await s.command(
      s.envelope('publish-now', { unitId: newId() }, { proof: await s.nonce() }),
    );
    expect(strictNoSig.body.code).toBe('signature-required');
    const strict = s.envelope('publish-now', { unitId: newId() });
    const signedHeader = s.device.signFor(strict);
    const signed = await s.command({ ...strict, proof: { signature: signedHeader } });
    // Полномочия приняты; сама публикация — фаза 6.
    expect(signed).toMatchObject({ status: 501, body: { code: 'not-implemented' } });
    // Повтор той же подписи под новым cmdId — номер подписи уже погашен.
    const replay = await s.command({
      ...strict,
      cmdId: newId(),
      proof: { signature: signedHeader },
    });
    expect(replay.body.code).toBe('signature-invalid');
    const lines = journal(s);
    const signals = lines
      .filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { signal: string }).signal);
    expect(signals).toEqual(['forged-authority', 'forged-authority', 'forged-authority']);
    const rejected = lines.filter((l) => l.kind === 'command.rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(8);
  });
});

function issueCodes(body: Record<string, unknown>): string[] {
  return ((body.issues as { code: string }[] | undefined) ?? []).map((i) => i.code);
}
