import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatLink } from './app-store.types.ts';
import { AppStore } from './store.ts';
import { carriedLink, continuationLink, unbornResumeTarget, unbornStageOf } from './chat-links.ts';

const parent = 'parent-1';
const link = (extra: Omit<Partial<ChatLink>, 'createdAt'> & { createdAt: string }): ChatLink => ({
  parentChatId: parent,
  groupIndex: 1,
  ...extra,
});

// Связи группы 1 живого прогона 20.10: план, две сессии работы, ревью под `new-`
// без настоящего ключа — пауза пришла до первого хода.
const live = (): Record<string, ChatLink> => ({
  'new-p': link({ stage: 'plan', createdAt: '2026-10-19T22:20:25Z', conversation: 'new-p' }),
  'plan-sid': link({ stage: 'plan', createdAt: '2026-10-19T22:20:25Z', conversation: 'new-p' }),
  'new-w1': link({
    stage: 'work',
    createdAt: '2026-10-19T22:26:28Z',
    conversation: 'new-w1',
    reviewedAt: '2026-10-20T06:28:26Z',
  }),
  'work1-sid': link({
    stage: 'work',
    createdAt: '2026-10-19T22:26:28Z',
    conversation: 'new-w1',
    reviewedAt: '2026-10-20T06:28:26Z',
  }),
  'new-w2': link({ stage: 'work', createdAt: '2026-10-19T22:40:35Z', conversation: 'new-w2' }),
  'work2-sid': link({ stage: 'work', createdAt: '2026-10-19T22:40:35Z', conversation: 'new-w2' }),
  'new-review': link({ stage: 'review', createdAt: '2026-10-20T06:28:24Z' }),
});

describe('unbornResumeTarget — чат стадии не родился', () => {
  it('ревью под временным ключом продолжается последней сессией работы группы', () => {
    expect(unbornResumeTarget(live(), 'new-review')).toEqual({
      chatId: 'work2-sid',
      clearReviewed: false,
    });
  });

  it('у выбранной работы отметка ревью снимается: ревью не было', () => {
    const links = live();
    delete links['new-w2'];
    delete links['work2-sid'];
    expect(unbornResumeTarget(links, 'new-review')).toEqual({
      chatId: 'work1-sid',
      clearReviewed: true,
    });
  });

  it('родившийся разговор сюда не попадает — он продолжается сам', () => {
    expect(unbornResumeTarget(live(), 'new-w2')).toBeUndefined();
  });

  it('план и чужая группа продолжением не служат', () => {
    const links = live();
    for (const key of ['new-w1', 'work1-sid', 'new-w2', 'work2-sid']) delete links[key];
    links['other-group'] = link({
      stage: 'work',
      groupIndex: 2,
      createdAt: '2026-10-19T23:00:00Z',
    });
    expect(unbornResumeTarget(links, 'new-review')).toBeUndefined();
  });

  it('сессия, заведённая позже нерождённой, не берётся', () => {
    const links = live();
    links['later-sid'] = link({ stage: 'work', createdAt: '2026-10-20T07:00:00Z' });
    expect(unbornResumeTarget(links, 'new-review')?.chatId).toBe('work2-sid');
  });
});

/**
 * Задание непорождённого звена (F-07): живёт в связи, пока разговор не родился.
 * Родился — задание знает его сессия, копия в состоянии не нужна; связь,
 * скопированная на другой разговор, чужого задания не несёт.
 */
describe('stagePrompt — задание звена до рождения разговора', () => {
  let dir = '';
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-stage-prompt-'));
    store = new AppStore(dir);
    store.setChatLink(
      'new-fix',
      link({ stage: 'fix', createdAt: '2026-10-21T10:00:00Z', stagePrompt: 'Fix: SENTINEL' }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('переживает перезапуск панели, пока звено не родилось', () => {
    expect(new AppStore(dir).getChatLink('new-fix')?.stagePrompt).toBe('Fix: SENTINEL');
  });

  it('рождение разговора снимает его под обоими ключами', () => {
    store.linkChatSession('new-fix', 'fix-sid');
    expect(store.getChatLink('fix-sid')?.stagePrompt).toBeUndefined();
    expect(store.getChatLink('new-fix')?.stagePrompt).toBeUndefined();
  });

  it('копия связи на другой разговор его не несёт', () => {
    expect(carriedLink(store.getChatLink('new-fix')!).stagePrompt).toBeUndefined();
  });

  // d9869abf:9, 26.10: пауза оборвала продолжение в чистой сессии до первого хода.
  it('продолжение группы несёт свою вводную, обычного разговора и без вводной — нет', () => {
    const work = store.getChatLink('new-fix')!;
    expect(continuationLink(work, 'BRIEF').stagePrompt).toBe('BRIEF');
    expect(continuationLink(work).stagePrompt).toBeUndefined();
    const { groupIndex: _solo, ...plain } = work;
    expect(continuationLink(plain, 'BRIEF').stagePrompt).toBeUndefined();
  });
});

// Группа d9869abf:5, 25.10: ревью родилось и кончилось, связь доставки заведена
// со своим заданием, а перезапуск панели оборвал её до первого хода.
describe('unbornStageOf — звено после текущего чата не родилось', () => {
  const review = {
    stage: 'review' as const,
    createdAt: '2026-10-25T16:49:46Z',
    conversation: 'new-r',
  };
  const born = (): Record<string, ChatLink> => ({
    'new-r': link(review),
    'review-sid': link(review),
    'new-d': link({ stage: 'deliver', createdAt: '2026-10-25T16:59:34Z', stagePrompt: 'Deliver' }),
  });

  it('доставка без разговора находится по чату ревью и по его сессии', () => {
    expect(unbornStageOf(born(), 'new-r')?.[0]).toBe('new-d');
    expect(unbornStageOf(born(), 'review-sid')?.[0]).toBe('new-d');
  });

  it('родившееся, снятое, чужое и более раннее звено — не оно', () => {
    const links = born();
    const d = links['new-d']!;
    const bornD = { ...d, conversation: 'new-d' };
    expect(
      unbornStageOf({ ...links, 'new-d': bornD, 'deliver-sid': bornD }, 'new-r'),
    ).toBeUndefined();
    expect(unbornStageOf({ ...links, 'new-d': { ...d, retiredAt: 'x' } }, 'new-r')).toBeUndefined();
    expect(unbornStageOf({ ...links, 'new-d': { ...d, groupIndex: 2 } }, 'new-r')).toBeUndefined();
    const { stagePrompt: _task, ...noTask } = d;
    expect(unbornStageOf({ ...links, 'new-d': noTask }, 'new-r')).toBeUndefined();
    const early = { ...d, createdAt: '2026-10-25T16:40:00Z' };
    expect(unbornStageOf({ ...links, 'new-d': early }, 'new-r')).toBeUndefined();
    expect(
      unbornStageOf({ ...links, 'new-d': { ...d, stage: 'review' } }, 'new-r'),
    ).toBeUndefined();
  });

  it('из двух нерождённых — новейшее', () => {
    const links = born();
    links['new-f'] = link({ stage: 'fix', createdAt: '2026-10-25T17:05:00Z', stagePrompt: 'Fix' });
    expect(unbornStageOf(links, 'new-r')?.[0]).toBe('new-f');
  });
});
