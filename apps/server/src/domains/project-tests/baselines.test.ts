import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptBaseline, compareBaseline, readBaselines } from './baselines.ts';
import { decodePng, encodePng } from './png.ts';

/**
 * Сравнение с эталоном. Проверяется ровно то, ради чего оно заведено: мелкий
 * шум не должен ронять прогон, настоящая разница не должна пройти молча, а
 * невозможность сравнить (битый эталон, другой размер) обязана быть НАЗВАНА —
 * тихое «совпало» здесь хуже отсутствия проверки.
 */
const NOW = '2026-09-07T10:00:00.000Z';

/** Однотонная картинка нужного размера. */
function solid(width: number, height: number, color: [number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = color[0];
    data[index * 4 + 1] = color[1];
    data[index * 4 + 2] = color[2];
    data[index * 4 + 3] = 255;
  }
  return encodePng({ width, height, data });
}

/** Та же картинка, но `count` пикселей другого цвета. */
function withSpots(width: number, height: number, count: number): Buffer {
  const image = decodePng(solid(width, height, [10, 20, 30]));
  for (let index = 0; index < count; index += 1) {
    image.data[index * 4] = 250;
    image.data[index * 4 + 1] = 250;
    image.data[index * 4 + 2] = 250;
  }
  return encodePng(image);
}

describe('project-tests baselines', () => {
  let root = '';
  const png = (relative: string): string => join(root, '.agent', 'tests', relative);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-baseline-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('первый снимок становится эталоном — сравнивать было не с чем', () => {
    const result = compareBaseline(root, {
      caseId: 'gui-001',
      pointId: 'gui|gui-001|local',
      png: solid(10, 10, [10, 20, 30]),
      now: NOW,
    });

    expect(result.status).toBe('new');
    expect(result.file).toBe('.agent/tests/baselines/gui-001/gui-gui-001-local.png');
    expect(existsSync(png('baselines/gui-001/gui-gui-001-local.png'))).toBe(true);
    expect(result.diffFile).toBeUndefined();
  });

  it('шум ниже порога — совпадение, и спорить не с чем', () => {
    const point = { caseId: 'gui-001', pointId: 'p1', now: NOW };
    compareBaseline(root, { ...point, png: solid(100, 100, [10, 20, 30]) });

    // 20 пикселей из 10 000 — 0,2% при пороге 0,5%.
    const result = compareBaseline(root, { ...point, png: withSpots(100, 100, 20) });

    expect(result.status).toBe('match');
    expect(result.diffRatio).toBeCloseTo(0.002, 5);
    expect(existsSync(png('baselines/gui-001/p1.diff.png'))).toBe(false);
    expect(existsSync(png('baselines/gui-001/p1.actual.png'))).toBe(false);
  });

  it('разница выше порога — снимок и картинка-разница рядом, эталон не тронут', () => {
    const point = { caseId: 'gui-001', pointId: 'p1', now: NOW };
    const before = solid(100, 100, [10, 20, 30]);
    compareBaseline(root, { ...point, png: before });

    const result = compareBaseline(root, { ...point, png: withSpots(100, 100, 500) });

    expect(result.status).toBe('diff');
    expect(result.diffRatio).toBeCloseTo(0.05, 5);
    expect(result.message).toContain('%');
    expect(readFileSync(png('baselines/gui-001/p1.png'))).toEqual(before);
    expect(existsSync(png('baselines/gui-001/p1.actual.png'))).toBe(true);

    // Отличия видно глазом: пурпурные пиксели там, где картинки разошлись.
    const diff = decodePng(readFileSync(png('baselines/gui-001/p1.diff.png')));
    expect([...diff.data.slice(0, 4)]).toEqual([255, 0, 255, 255]);
  });

  it('свой порог кейса важнее общего', () => {
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    writeFileSync(
      join(root, '.agent', 'tests', 'gui.tests.json'),
      JSON.stringify({
        version: 1,
        cases: [{ id: 'gui-001', title: 'Экран с анимацией', maxDiffRatio: 0.2 }],
      }),
    );
    const point = { caseId: 'gui-001', pointId: 'p1', now: NOW };
    compareBaseline(root, { ...point, png: solid(100, 100, [10, 20, 30]) });

    const result = compareBaseline(root, { ...point, png: withSpots(100, 100, 500) });

    expect(result.status).toBe('match');
    expect(result.maxDiffRatio).toBe(0.2);
  });

  it('другой размер — названный провал, а не «совпало»', () => {
    const point = { caseId: 'gui-001', pointId: 'p1', now: NOW };
    compareBaseline(root, { ...point, png: solid(100, 100, [10, 20, 30]) });

    const result = compareBaseline(root, { ...point, png: solid(80, 100, [10, 20, 30]) });

    expect(result.status).toBe('error');
    expect(result.message).toContain('80×100');
    expect(result.message).toContain('100×100');
  });

  it('битый эталон — причина словами, и файл остаётся как был', () => {
    const point = { caseId: 'gui-001', pointId: 'p1', now: NOW };
    compareBaseline(root, { ...point, png: solid(10, 10, [10, 20, 30]) });
    writeFileSync(png('baselines/gui-001/p1.png'), 'испорчено');

    const result = compareBaseline(root, { ...point, png: solid(10, 10, [10, 20, 30]) });

    expect(result.status).toBe('error');
    expect(result.message).toContain('Эталон не читается');
    expect(readFileSync(png('baselines/gui-001/p1.png'), 'utf8')).toBe('испорчено');
  });

  it('человек принимает снимок эталоном — и спор закрыт', () => {
    const point = { caseId: 'gui-001', pointId: 'p1', now: NOW };
    compareBaseline(root, { ...point, png: solid(100, 100, [10, 20, 30]) });
    const after = withSpots(100, 100, 500);
    compareBaseline(root, { ...point, png: after });

    const accepted = acceptBaseline(root, 'gui-001', 'p1', NOW);

    expect(accepted.status).toBe('match');
    expect(readFileSync(png('baselines/gui-001/p1.png'))).toEqual(after);
    expect(existsSync(png('baselines/gui-001/p1.actual.png'))).toBe(false);
    expect(existsSync(png('baselines/gui-001/p1.diff.png'))).toBe(false);
  });

  it('принимать нечего — 404, а не молчаливое «ок»', () => {
    expect(() => acceptBaseline(root, 'gui-001', 'p1', NOW)).toThrow(/нового снимка/i);
  });

  it('список эталонов показывает и спорные, и совпавшие', () => {
    compareBaseline(root, {
      caseId: 'gui-001',
      pointId: 'p1',
      png: solid(100, 100, [10, 20, 30]),
      now: NOW,
    });
    compareBaseline(root, {
      caseId: 'gui-002',
      pointId: 'p1',
      png: solid(100, 100, [10, 20, 30]),
      now: NOW,
    });
    compareBaseline(root, {
      caseId: 'gui-002',
      pointId: 'p1',
      png: withSpots(100, 100, 500),
      now: NOW,
    });

    const all = readBaselines(root);
    const one = readBaselines(root, 'gui-002');

    expect(all).toHaveLength(2);
    expect(one).toHaveLength(1);
    expect(one[0]?.status).toBe('diff');
    expect(one[0]?.diffFile).toBe('.agent/tests/baselines/gui-002/p1.diff.png');
  });
});
