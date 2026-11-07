import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { i18n } from '@shared/config/i18n';
import { emptyDraft } from '../../model/launchDraft';
import { emptyItem } from '../../model/launchSource';
import type { ItemsAs, LaunchDraft } from '../../model/launch.types';
import { EstimateCard } from '../EstimateCard/EstimateCard';
import { SourcePicker } from './SourcePicker';

/**
 * «Несколько пунктов» настоящей разметкой (этап 11, W3-16 + W3-18): выбор «одной задачей» /
 * «группой — задача на пункт» стоит над пунктами, по умолчанию — одна задача; оценка группы
 * называет группу и каждую её задачу ссылкой на ленту — при любом сценарии, не только у ведущего.
 */

const itemsDraft = (itemsAs: ItemsAs): LaunchDraft => ({
  ...emptyDraft(),
  source: { ...emptyDraft().source, mode: 'items', items: [emptyItem(1)], itemsAs },
});

const picker = (draft: LaunchDraft) =>
  renderToStaticMarkup(<SourcePicker draft={draft} onDraft={() => {}} />);

const selected = (html: string) =>
  [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*selected=""/g)].map((m) => m[1]);

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('items as one task or a group (W3-16, W3-18)', () => {
  it('the choice sits over the items, one task by default', () => {
    const html = picker({
      ...emptyDraft(),
      source: { ...emptyDraft().source, mode: 'items', items: [emptyItem(1)] },
    });
    expect(html).toContain('data-source-items-as="one"');
    expect(html).toContain('Как запустить пункты');
    expect(html).toContain('Одной задачей');
    expect(html).toContain('Группой — задача на пункт');
    expect(selected(html)).toContain('one');
    expect(html).toContain('Ядро разбирает пункты вместе');
  });

  it('the group choice is shown as chosen with its own hint', () => {
    const html = picker(itemsDraft('group'));
    expect(html).toContain('data-source-items-as="group"');
    expect(selected(html)).toContain('group');
    expect(html).toContain('Ядро ставит задачу на каждый пункт');
  });

  it('other sources show no choice', () => {
    expect(picker(emptyDraft())).not.toContain('data-source-items-as');
  });

  it('a group estimate names the group and links every task, without a lead block', () => {
    const reply = {
      taskId: 't0',
      state: 'estimating',
      replayed: false,
      estimate: { minutes: null, tokens: null, spread: null, basis: 'no-history' },
      problems: [],
      group: { groupId: 'group-c1', taskIds: ['t0', 't1', 't2'] },
    } as unknown as EstimateReply;
    const html = renderToStaticMarkup(<EstimateCard reply={reply} />);
    expect(html).toContain('data-estimate-group="group-c1"');
    expect(html).toContain('Группа group-c1: задач 3');
    expect([...html.matchAll(/href="\/core\?id=(t\d)"/g)].map((m) => m[1])).toEqual([
      't0',
      't1',
      't2',
    ]);
    // Цвет ссылки — акцент темы, а не синий браузера, который в тёмной теме не читается.
    const links = [...html.matchAll(/<a href="\/core\?id=t\d"[^>]*>(.*?)<\/a>/g)];
    expect(links).toHaveLength(3);
    for (const [link, inner] of links) {
      expect(link).toMatch(/class="[^"]*feedLink/);
      expect(inner).toMatch(/^<span class="[^"]*color-accent/);
    }
    const single = renderToStaticMarkup(<EstimateCard reply={{ ...reply, group: undefined }} />);
    expect(single).not.toContain('data-estimate-group');
  });
});
