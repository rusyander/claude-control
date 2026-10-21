import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatLink } from './app-store.types.ts';
import { AppStore } from './store.ts';
import { carriedLink, unbornResumeTarget } from './chat-links.ts';

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
});
