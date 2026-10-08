import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KnobView } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { KnobSelect } from './KnobSelect';

const knob = (patch: Partial<KnobView>): KnobView => ({
  skillId: 'review',
  key: 'rounds',
  label: { ru: 'Круги', en: 'Rounds' },
  quote: 'up to 3 rounds',
  default: 3,
  min: 1,
  max: 5,
  value: 3,
  auto: true,
  overridden: false,
  ...patch,
});

const render = (view: KnobView): string =>
  renderToStaticMarkup(
    <KnobSelect knob={view} stepTitle="шаг" isSaving={false} onChange={() => undefined} />,
  );

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('список числа скилла: закреплённое вне min..max', () => {
  it('выбрано само закреплённое число с пометкой «вне диапазона», а не «Авто» (F-75)', () => {
    const html = render(knob({ auto: false, value: 8, overridden: true }));
    expect(html).toMatch(/<option value="8" selected="">8 \(вне диапазона 1–5\)<\/option>/);
    expect(html).not.toMatch(/<option value="auto" selected/);
  });

  it('в диапазоне — обычный пункт, пометки нет', () => {
    const html = render(knob({ auto: false, value: 4, overridden: true }));
    expect(html).toMatch(/<option value="4" selected="">4<\/option>/);
    expect(html).not.toContain('вне диапазона');
  });

  it('«Авто» пометки не даёт, даже если умолчание скилла вне нового диапазона', () => {
    const html = render(knob({ auto: true, value: 9, default: 9 }));
    expect(html).toMatch(/<option value="auto" selected/);
    expect(html).not.toContain('вне диапазона');
  });
});
