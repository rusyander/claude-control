import { describe, expect, it } from 'vitest';
import { PICK_MESSAGE_TYPE, type PickPayload } from '@agentdeck/contracts/site-preview';
import { describePick } from './pickBlock';

/** Описание выбранного элемента: чип коротко, агенту — все поля и разметка в ограде (D20). */
const labels = {
  header: 'Элемент со страницы сайта:',
  url: 'адрес',
  selector: 'селектор',
  tag: 'тег',
  text: 'текст',
  rect: 'место на странице',
  html: 'разметка',
  empty: '(пусто)',
};
const pick: PickPayload = {
  type: PICK_MESSAGE_TYPE,
  nonce: 'n0nce-0123456789abcdef',
  selector: 'main > section.cards > button:nth-of-type(2)',
  tag: 'button',
  text: 'Pay for\n  the order',
  outerHTML: '<button class="buy" data-token="[скрыто]">Pay for the order</button>',
  rect: { x: 10.4, y: 20.6, width: 120, height: 32.2 },
  url: 'http://localhost:5173/shop',
};

describe('describePick', () => {
  it('раскладывает выбор по полям блока', () => {
    const { block, label, title } = describePick(pick, labels);
    expect(block.split('\n')).toEqual([
      'Элемент со страницы сайта:',
      '- адрес: http://localhost:5173/shop',
      '- селектор: main > section.cards > button:nth-of-type(2)',
      '- тег: button',
      '- текст: Pay for the order',
      '- место на странице: x=10 y=21 120×32',
      '- разметка:',
      '```html',
      '<button class="buy" data-token="[скрыто]">Pay for the order</button>',
      '```',
    ]);
    expect(label).toBe('<button> Pay for the order');
    expect(title).toBe(pick.selector);
  });

  it('ограда длиннее обратных кавычек в разметке — сайт её не закроет', () => {
    const { block } = describePick({ ...pick, outerHTML: '<pre>````x````</pre>' }, labels);
    const lines = block.split('\n');
    expect(lines.at(-3)).toBe('`````html');
    expect(lines.at(-1)).toBe('`````');
  });

  it('пустой текст назван, длинный подписан коротко', () => {
    expect(describePick({ ...pick, text: '' }, labels).block).toContain('- текст: (пусто)');
    expect(describePick({ ...pick, text: '' }, labels).label).toBe('<button>');
    const long = describePick({ ...pick, text: 'a'.repeat(60) }, labels).label;
    expect(long).toBe(`<button> ${'a'.repeat(40)}…`);
  });
});
