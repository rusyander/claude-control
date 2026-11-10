import { describe, expect, it } from 'vitest';
import {
  PICK_CANCEL_TYPE,
  PICK_MESSAGE_TYPE,
  type PickPayload,
  type SitePreview,
} from '@agentdeck/contracts/site-preview';
import { acceptPick, isPickCancel } from './acceptPick';

/**
 * Окно чата принимает выбор элемента только от своего iframe, со своего прокси и со своим
 * `nonce` (P174): чужая страница, другое окно или старое окно сайта выбор не подделают.
 */
const NONCE = 'n0nce-0123456789abcdef';
const preview: SitePreview = { siteId: 'site-1', url: 'http://127.0.0.1:41234/', nonce: NONCE };
// Окна — просто разные объекты: приём сравнивает источник по ссылке.
const frame = {} as Window;
const otherWindow = {} as Window;

const pick: PickPayload = {
  type: PICK_MESSAGE_TYPE,
  nonce: NONCE,
  selector: 'main > section.cards > button:nth-of-type(2)',
  tag: 'button',
  text: 'Pay for the order',
  outerHTML: '<button class="buy">Pay for the order</button>',
  rect: { x: 10, y: 20, width: 120, height: 32 },
  url: 'http://127.0.0.1:41234/',
};
const own = (data: unknown) => ({ source: frame, origin: 'http://127.0.0.1:41234', data });

describe('acceptPick', () => {
  it('принимает выбор своего iframe с адреса прокси и своим nonce', () => {
    expect(acceptPick(own(pick), frame, preview)).toEqual(pick);
  });

  it('отвергает чужое происхождение — даже с верным nonce и окном', () => {
    const foreign = { source: frame, origin: 'http://127.0.0.1:5173', data: pick };
    expect(acceptPick(foreign, frame, preview)).toBeUndefined();
    expect(
      acceptPick({ ...foreign, origin: 'http://evil.example' }, frame, preview),
    ).toBeUndefined();
  });

  it('отвергает сообщение другого окна с того же адреса', () => {
    const elsewhere = { source: otherWindow, origin: 'http://127.0.0.1:41234', data: pick };
    expect(acceptPick(elsewhere, frame, preview)).toBeUndefined();
    expect(acceptPick(own(pick), null, preview)).toBeUndefined();
  });

  it('отвергает чужой nonce и сообщение не по схеме', () => {
    expect(
      acceptPick(own({ ...pick, nonce: 'other-nonce-0123456789' }), frame, preview),
    ).toBeUndefined();
    expect(acceptPick(own({ ...pick, extra: 1 }), frame, preview)).toBeUndefined();
    expect(acceptPick(own('agentdeck:pick'), frame, preview)).toBeUndefined();
  });
});

describe('isPickCancel', () => {
  const cancel = { type: PICK_CANCEL_TYPE, nonce: NONCE };

  it('узнаёт Escape своего окна и не верит чужому', () => {
    expect(isPickCancel(own(cancel), frame, preview)).toBe(true);
    expect(isPickCancel(own({ ...cancel, nonce: 'x' }), frame, preview)).toBe(false);
    expect(isPickCancel({ ...own(cancel), source: otherWindow }, frame, preview)).toBe(false);
    expect(isPickCancel(own(null), frame, preview)).toBe(false);
  });
});
