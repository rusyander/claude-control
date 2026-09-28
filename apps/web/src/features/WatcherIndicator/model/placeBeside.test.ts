import { describe, expect, it } from 'vitest';
import { placePopover } from './placeBeside';

const base = { width: 320, height: 214, gap: 8, margin: 16 };

describe('placePopover', () => {
  it('телефон 400 px: строка шире свёрнутой панели — окно у края панели и целиком в экране', () => {
    const place = placePopover({
      ...base,
      anchor: { top: 158, right: 236 },
      clip: { right: 60 },
      viewport: { width: 400, height: 800 },
    });
    expect(place.left).toBeGreaterThanOrEqual(60);
    expect(place.left + base.width).toBeLessThanOrEqual(400 - base.margin);
    expect(place.top).toBe(158);
  });

  it('широкий экран, панель развёрнута: окно сразу за строкой', () => {
    const place = placePopover({
      ...base,
      anchor: { top: 200, right: 236 },
      clip: { right: 244 },
      viewport: { width: 1440, height: 900 },
    });
    expect(place).toEqual({ left: 244, top: 200 });
  });

  it('свёрнутая панель на широком экране: окно у видимого края, а не за спрятанной подписью', () => {
    const place = placePopover({
      ...base,
      anchor: { top: 200, right: 236 },
      clip: { right: 60 },
      viewport: { width: 1440, height: 900 },
    });
    expect(place.left).toBe(68);
  });

  it('снизу не вылезает за экран', () => {
    const place = placePopover({
      ...base,
      anchor: { top: 780, right: 60 },
      viewport: { width: 1440, height: 800 },
    });
    expect(place.top).toBe(800 - base.margin - base.height);
  });
});
