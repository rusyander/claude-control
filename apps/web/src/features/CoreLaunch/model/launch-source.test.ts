import { describe, expect, it } from 'vitest';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import type { IntakeSource } from '@agentdeck/contracts/core/intake';
import { emptyDraft, fieldsOf } from './launchDraft';
import {
  emptyItem,
  sourceDigest,
  sourceFieldsOf,
  withSnapshot,
  withTrackerKey,
} from './launchSource';
import type { LaunchDraft } from './launch.types';

/**
 * Источник задачи на форме запуска (этап 11, P133): текст — без поля источника; трекер — снимок
 * панели как есть; голос и пункты — снимок формы с отпечатком; тот же черновик — те же поля.
 */

const SNAP: IntakeSource = {
  kind: 'tracker',
  key: 'PROJ-12',
  title: 'Кнопка экспорта',
  body: 'Добавить кнопку.',
  acceptance: ['видна', 'CSV полный'],
  fetchedAt: 1000,
  digest: 'a'.repeat(64),
};

const base = (patch: Partial<LaunchDraft> = {}): LaunchDraft => ({
  ...emptyDraft(),
  repos: [{ path: '/r', baseRef: '' }],
  ...patch,
});

describe('launch source (W3-16)', () => {
  it('text: no source field, request is the text', async () => {
    const draft = base({ title: 'T', request: 'R' });
    const src = await sourceFieldsOf(draft);
    expect(src).toEqual({ ok: true, fields: {} });
    const got = fieldsOf(draft, 'ru', src.ok ? src.fields : {});
    expect(got.ok && 'source' in got.fields).toBe(false);
  });

  it('tracker: unread is a problem; a read snapshot fills empty title/request and is sent as is', async () => {
    const unread = base({
      source: { ...emptyDraft().source, mode: 'tracker', trackerKey: 'PROJ-12' },
    });
    expect(await sourceFieldsOf(unread)).toEqual({ ok: false, problem: 'tracker-unread' });
    const read = withSnapshot(unread, SNAP, 'PROJ-12');
    expect(read.title).toBe('Кнопка экспорта');
    expect(read.request).toBe('Добавить кнопку.');
    const src = await sourceFieldsOf(read);
    const got = fieldsOf(read, 'ru', src.ok ? src.fields : {});
    expect(got.ok && got.fields.source).toEqual(SNAP);
    expect(got.ok && estimateFieldsSchema.safeParse(got.fields).success).toBe(true);
  });

  it('a typed title is kept when the snapshot arrives', () => {
    const read = withSnapshot(base({ title: 'Мой заголовок' }), SNAP, '');
    expect(read.title).toBe('Мой заголовок');
  });

  const OTHER: IntakeSource = {
    ...SNAP,
    key: 'PROJ-13',
    title: 'Другая задача',
    body: 'Другие требования.',
    digest: 'b'.repeat(64),
  };
  const tracker = (trackerKey: string, patch: Partial<LaunchDraft> = {}) =>
    base({ ...patch, source: { ...emptyDraft().source, mode: 'tracker', trackerKey } });

  it('another key: the text the old snapshot filled leaves with it, typed text stays', () => {
    const first = withSnapshot(tracker('PROJ-12'), SNAP, 'PROJ-12');
    const rekeyed = withTrackerKey(first, 'PROJ-13');
    expect(rekeyed).toMatchObject({ title: '', request: '', source: { snapshot: null } });
    const second = withSnapshot(rekeyed, OTHER, 'PROJ-13');
    expect([second.title, second.request]).toEqual(['Другая задача', 'Другие требования.']);
    // Правка человека — не текст снимка: смена ключа её не трогает.
    const typed = withTrackerKey({ ...first, request: 'Моё' }, 'PROJ-13');
    expect([typed.title, typed.request]).toEqual(['', 'Моё']);
    // Повторное чтение того же ключа обновляет заполненный им текст.
    const reread = withSnapshot(first, { ...SNAP, title: 'Новое имя' }, 'PROJ-12');
    expect(reread.title).toBe('Новое имя');
  });

  it('a late answer for a key that is no longer in the field does not land', () => {
    const draft = tracker('PROJ-13', { title: 'T' });
    expect(withSnapshot(draft, SNAP, 'PROJ-12')).toBe(draft);
  });

  it('voice: the transcript is the source body; the same draft gives the same digest', async () => {
    const draft = base({
      title: 'T',
      request: 'Сделай отчёт',
      source: { ...emptyDraft().source, mode: 'voice', voiceAt: 5 },
    });
    const a = await sourceFieldsOf(draft);
    const b = await sourceFieldsOf(draft);
    expect(a).toEqual(b);
    expect(a.ok && a.fields.source).toMatchObject({
      kind: 'voice',
      body: 'Сделай отчёт',
      fetchedAt: 5,
    });
    expect(a.ok && a.fields.source?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('items: filled items become sources[]; request falls back to their bodies', async () => {
    const draft = base({
      title: 'Группа',
      source: {
        ...emptyDraft().source,
        mode: 'items',
        items: [
          { title: 'Первый', body: 'Текст 1', at: 1 },
          emptyItem(2),
          { title: '', body: 'Текст 3', at: 3 },
        ],
      },
    });
    const src = await sourceFieldsOf(draft);
    expect(src.ok && src.fields.sources?.map((s) => s.body)).toEqual(['Текст 1', 'Текст 3']);
    const got = fieldsOf(draft, 'ru', src.ok ? src.fields : {});
    expect(got.ok && got.fields.request).toBe('Текст 1\n\nТекст 3');
    expect(got.ok && estimateFieldsSchema.safeParse(got.fields).success).toBe(true);
    const empty = base({
      source: { ...emptyDraft().source, mode: 'items', items: [emptyItem(1)] },
    });
    expect(await sourceFieldsOf(empty)).toEqual({ ok: false, problem: 'items-empty' });
  });

  it('items as a group: every item is a group-item, never a mix; one task (default) stays text', async () => {
    const items = [
      { title: 'Первый', body: 'Текст 1', at: 1 },
      { title: '', body: 'Текст 2', at: 2 },
    ];
    const draft = (itemsAs: 'one' | 'group') =>
      base({
        title: 'Группа',
        source: { ...emptyDraft().source, mode: 'items', items, itemsAs },
      });
    expect(emptyDraft().source.itemsAs).toBe('one');
    const one = await sourceFieldsOf(draft('one'));
    expect(one.ok && one.fields.sources?.map((s) => s.kind)).toEqual(['text', 'text']);
    const group = await sourceFieldsOf(draft('group'));
    expect(group.ok && group.fields.sources?.map((s) => s.kind)).toEqual([
      'group-item',
      'group-item',
    ]);
    // Вид входит в отпечаток: пункт группы и пункт одной задачи — разные источники.
    expect(group.ok && one.ok && group.fields.sources?.[0]?.digest).not.toBe(
      one.ok && one.fields.sources?.[0]?.digest,
    );
    const got = fieldsOf(draft('group'), 'ru', group.ok ? group.fields : {});
    expect(got.ok && estimateFieldsSchema.safeParse(got.fields).success).toBe(true);
  });

  it('the digest is sha256 of the content without the snapshot time', async () => {
    const one = await sourceDigest({ kind: 'text', body: 'x' });
    expect(one).toBe(await sourceDigest({ kind: 'text', body: 'x' }));
    expect(one).not.toBe(await sourceDigest({ kind: 'text', body: 'y' }));
  });
});
