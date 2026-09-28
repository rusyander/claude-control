import { describe, expect, it } from 'vitest';
import {
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_KEY,
  DOCK_WIDTH_MIN,
  clampDockWidth,
  dockWidthMax,
  readDockWidth,
  writeDockWidth,
} from './dockWidth';

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

describe('ширина окна агента', () => {
  it('верхняя граница оставляет странице 480 px и не выше 960; на тесном экране — нижняя', () => {
    expect(dockWidthMax(1280)).toBe(800);
    expect(dockWidthMax(1920)).toBe(960);
    expect(dockWidthMax(900)).toBe(420);
    expect(dockWidthMax(820)).toBe(DOCK_WIDTH_MIN);
  });

  it('ширина зажата в границы экрана', () => {
    expect(clampDockWidth(100, 1280)).toBe(DOCK_WIDTH_MIN);
    expect(clampDockWidth(5000, 1280)).toBe(800);
    expect(clampDockWidth(612.4, 1920)).toBe(612);
  });

  it('сохраняется и читается; нет записи или она битая — по умолчанию', () => {
    const storage = memory();
    expect(readDockWidth(storage)).toBe(DOCK_WIDTH_DEFAULT);
    writeDockWidth(storage, 587.6);
    expect(storage.data.get(DOCK_WIDTH_KEY)).toBe('588');
    expect(readDockWidth(storage)).toBe(588);
    expect(readDockWidth(memory({ [DOCK_WIDTH_KEY]: 'wide' }))).toBe(DOCK_WIDTH_DEFAULT);
    expect(readDockWidth(undefined)).toBe(DOCK_WIDTH_DEFAULT);
  });

  it('хранилище, бросающее при записи, окно не роняет', () => {
    const broken = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => writeDockWidth(broken, 500)).not.toThrow();
  });
});
