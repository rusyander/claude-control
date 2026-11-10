import { createHash } from 'node:crypto';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_OWNER_HEADER,
  telegramOwnerInput,
} from '@agentdeck/contracts/core/telegram-channel';
import { afterEach, describe, expect, it } from 'vitest';
import { raiseHumanPoint } from '../conductor/human/raise.ts';
import { raiseTrackerWriteAsk } from '../conductor/human/tracker-write-ask.ts';
import { labelOf } from '../conductor/next/answers.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { startStand, TRUSTED_HOP_PID, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Ответ из Telegram через настоящий Fastify ядра (этап 12, D29, P187, P188): звено панели шлёт
 * команду с заголовками канала и отпечатком владельца. Ответ `grant` пункта 5 — только ответ
 * (никакого `grant.given`), журнал: пир `telegram`, актёр `human:telegram`, канал ответа
 * `telegram`. Открытие пункта 3, грант и чужой отпечаток — отказ, журнал вопроса не тронут.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const OWNER = createHash('sha256')
  .update(
    telegramOwnerInput({ apiBase: 'http://127.0.0.1:9', botId: '1', chatId: '2', fromId: '2' }),
  )
  .digest('hex');

const viaTelegram = (owner = OWNER) => ({
  headers: { [HUMAN_CHANNEL_HEADER]: 'telegram', [TELEGRAM_OWNER_HEADER]: owner },
});

describe('a core ask answered from Telegram through the core API (stage 12, D29)', () => {
  it('point-5 grant applies as an answer; point-3 allow, grant and a foreign owner are refused', async () => {
    let owner: string | null = OWNER;
    stand = await startStand(undefined, { telegramOwner: () => owner });
    const s = stand;
    const opened = await s.registry.open(s.taskId);
    if (!('task' in opened)) throw new Error(opened.refused);
    const task = opened.task;
    const seeded = seedSession(task, { stepKind: 'work' });
    const raise = (point: 3 | 5, options: string[], target: string) => {
      const raised = raiseHumanPoint(task, {
        source: 'permit',
        stepId: seeded.stepId,
        sessionId: seeded.sessionId,
        action: { kind: 'path', target },
        point,
        dedupe: `permit:${seeded.stepId}:${point}:edit:${target}`,
        question: `The step needs a grant to edit ${target} (Edit)`,
        options,
        recommendation: 'refuse',
        blocking: true,
      });
      if (raised.kind !== 'asked') throw new Error(`ask not raised: ${raised.kind}`);
      return raised.askId;
    };
    const five = raise(5, ['grant', 'refuse'], 'migrations/1.sql');
    const three = raise(3, ['allow', 'refuse'], 'src/a.ts');
    s.peer.direct = TRUSTED_HOP_PID;
    const lines = () => readJournalLines(task.dir, task.taskId).lines;
    const effects = () =>
      lines().filter((l) => l.kind === 'grant.given' || l.kind === 'human.answered');

    // Открытие пункта 3 из Telegram — суд области, журнал вопроса не тронут.
    const allow = s.envelope('answer', { askId: three, answer: 'allow' });
    expect(await s.command({ ...allow, proof: await s.nonce() }, viaTelegram())).toMatchObject({
      body: { code: 'telegram-binding' },
    });
    // Грант шире вопроса — только подпись устройства.
    const grant = s.envelope('grant', { project: 'r1', globs: ['**'], ops: ['edit'] });
    expect(await s.command({ ...grant, proof: await s.nonce() }, viaTelegram())).toMatchObject({
      status: 403,
      body: { code: 'signature-required' },
    });
    // Отпечаток другого владельца — не пир telegram: ответ не принят.
    const foreign = s.envelope('answer', { askId: five, answer: 'grant' });
    const refused = await s.command(
      { ...foreign, proof: await s.nonce() },
      viaTelegram('e'.repeat(64)),
    );
    expect(refused.status).not.toBe(200);
    expect(effects()).toEqual([]);

    const answer = s.envelope('answer', { askId: five, answer: 'grant' });
    const applied = await s.command({ ...answer, proof: await s.nonce() }, viaTelegram());
    expect(applied).toMatchObject({ status: 200, body: { status: 'applied' } });
    expect(effects().map((l) => [l.kind, l.data])).toEqual([
      ['human.answered', { askId: five, answer: 'grant', channel: 'telegram' }],
    ]);
    const received = lines().find((l) => l.kind === 'command.received' && l.cmdId === answer.cmdId);
    expect(received).toMatchObject({
      actor: 'human:telegram',
      data: { proof: { peer: 'telegram' } },
    });

    // Повтор того же нажатия — тот же cmdId, второй строки нет.
    const before = lines().length;
    const replay = await s.command({ ...answer, proof: await s.nonce() }, viaTelegram());
    expect(replay.status).toBe(200);
    expect(lines().length).toBe(before);

    // Владелец снят в настройке — тот же отпечаток уже не пир telegram.
    owner = null;
    const refuse = s.envelope('answer', { askId: three, answer: 'refuse' });
    const unbound = await s.command({ ...refuse, proof: await s.nonce() }, viaTelegram());
    expect(unbound.status).not.toBe(200);
    expect(effects()).toHaveLength(1);
  });

  it('point-9 tracker-write: «approve» from Telegram is refused before the ledger, «decline» applies', async () => {
    stand = await startStand(undefined, { telegramOwner: () => OWNER });
    const s = stand;
    const opened = await s.registry.open(s.taskId);
    if (!('task' in opened)) throw new Error(opened.refused);
    const task = opened.task;
    const raised = raiseTrackerWriteAsk(
      task,
      { system: 'jira', key: 'PROJ-7' },
      { unitId: '019a0000-0000-7000-8000-0000000000b1', url: 'https://forge.example.com/mr/7' },
    );
    if (raised.kind !== 'asked') throw new Error(`ask not raised: ${raised.kind}`);
    const askId = raised.askId;
    s.peer.direct = TRUSTED_HOP_PID;
    const answered = () =>
      readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === 'human.answered');

    // Запись в трекер выходит за копию задачи: «разрешить» на обоих языках — суд области, вопрос открыт.
    for (const label of [
      labelOf('trackerWrite', 'ru', 'approve'),
      labelOf('trackerWrite', 'en', 'approve'),
    ]) {
      const approve = s.envelope('answer', { askId, answer: label });
      expect(await s.command({ ...approve, proof: await s.nonce() }, viaTelegram())).toMatchObject({
        body: { code: 'telegram-binding' },
      });
    }
    expect(answered()).toEqual([]);

    // Отказ — сужение: проходит из Telegram.
    const decline = labelOf('trackerWrite', 'ru', 'decline');
    const no = s.envelope('answer', { askId, answer: decline });
    expect(await s.command({ ...no, proof: await s.nonce() }, viaTelegram())).toMatchObject({
      status: 200,
      body: { status: 'applied' },
    });
    expect(answered().map((l) => l.data)).toEqual([
      { askId, answer: decline, channel: 'telegram' },
    ]);
  });
});
