import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECORDED_MARK, buildRecorded, recordedFile, recordedTestName } from './codegen.ts';
import { WALK_SECRET, walkRows } from './__fixtures__/walk-rows.ts';

const ORIGIN = 'http://127.0.0.1:4173';

describe('recorded codegen', () => {
  afterEach(() => vi.useRealTimers());

  it('same rows give a byte-identical spec, whatever the clock says', () => {
    const testName = recordedTestName('Вход на стенд');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = buildRecorded({ testName, ...walkRows(ORIGIN) }).spec;
    vi.setSystemTime(new Date('2031-07-15T13:45:00Z'));
    const second = buildRecorded({ testName, ...walkRows(ORIGIN) }).spec;
    expect(second).toBe(first);
    expect(first).not.toMatch(/20(26|31)-/);
  });

  it('reads a secret from process.env by name and never writes its value', () => {
    const rows = walkRows(ORIGIN);
    const spec = buildRecorded({ testName: recordedTestName('x'), ...rows }).spec;
    // Набор доступа — только через охрану адреса стенда (`fillSecret`), не голым `fill`.
    expect(spec).toContain(
      `await fillSecret(page.getByLabel("Пароль", { exact: true }), "${WALK_SECRET}");`,
    );
    expect(spec).not.toContain(`process.env.${WALK_SECRET}`);
    expect(spec).toContain(`const SECRETS = ["${WALK_SECRET}"];`);
    // Значение по ошибке пришло в строке рядом с именем — спек его всё равно не пишет.
    const leaked = rows.steps.map((step) =>
      step.secret ? { ...step, value: 'hunter2-must-not-leak' } : step,
    );
    const again = buildRecorded({
      testName: recordedTestName('x'),
      steps: leaked,
      gaps: rows.gaps,
    });
    expect(again.spec).not.toContain('hunter2-must-not-leak');
    expect(again.spec).toContain(
      `fillSecret(page.getByLabel("Пароль", { exact: true }), "${WALK_SECRET}")`,
    );
  });

  it('declares the full test name on its first line and numbers playable steps 1..k', () => {
    const testName = recordedTestName('  Вход   на\nстенд ');
    expect(testName).toBe('recorded > Вход на стенд');
    const built = buildRecorded({ testName, ...walkRows(ORIGIN) });
    expect(built.spec.split('\n')[0]).toBe(`${RECORDED_MARK}recorded > Вход на стенд`);
    expect(built.playable.map((item) => item.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(built.playable.map((item) => item.step.action)).toEqual([
      'open',
      'fill',
      'fill',
      'click',
      'expect',
      'expect',
    ]);
    expect(built.spec).toContain('[4, "нажать button «Войти»", async () => {');
    expect(built.spec).toContain(
      'await page.getByRole("button", { name: "Войти", exact: true }).click();',
    );
    // Свой стенд — путём: тот же спек гоняется на другом адресе.
    expect(built.spec).toContain('await page.goto(at("/login"));');
    expect(built.spec).toContain(`const BASE = process.env.E2E_BASE_URL || "${ORIGIN}";`);
    expect(built.spec).not.toContain('snapshot');
  });

  it('turns gaps and steps failed at recording into «не проверено» case steps in journal order', () => {
    const built = buildRecorded({ testName: recordedTestName('x'), ...walkRows(ORIGIN) });
    expect(built.unchecked).toBe(2);
    expect(built.caseSteps.map((step) => step.action)).toEqual([
      'Шаг 1. открыть http://127.0.0.1:4173/login',
      'Шаг 2. ввести «demo@example.com» в поле «Почта»',
      `Шаг 3. ввести доступ ${WALK_SECRET} в поле «Пароль»`,
      'Не проверено: нажать link «Забыли пароль?»',
      'Шаг 4. нажать button «Войти»',
      'Не проверено: наведение button «Меню» — подменю открывается только наведением',
      'Шаг 5. Проверить: в элемент data-testid «greeting» текст «Привет, demo»',
      'Шаг 6. Проверить: адрес страницы http://127.0.0.1:4173/home',
    ]);
    expect(built.spec).toContain('  // Не проверено: нажать link «Забыли пароль?»');
    expect(built.spec).not.toContain('Забыли пароль?", exact');
  });

  it('puts the spec under the group folder by case id', () => {
    expect(recordedFile('tests-recorded', 'tests-recorded-001')).toBe(
      '.agent/tests/recorded/tests-recorded/tests-recorded-001.recorded.mjs',
    );
  });

  it('a failed secret fill reports the error with the value masked', async () => {
    const spec = buildRecorded({ testName: recordedTestName('x'), ...walkRows(ORIGIN) }).spec;
    // Исполняется настоящая `fillSecret` из сгенерированного спека, подменены только страница и поле.
    const source = /async function fillSecret\([\s\S]*?\n}\n/.exec(spec)?.[0];
    expect(source).toBeDefined();
    const value = 'hunter2-long-value';
    const make = new Function('page', 'BASE', 'process', `${source}\nreturn fillSecret;`);
    const fillSecret = make({ url: () => `${ORIGIN}/login` }, ORIGIN, {
      env: { [WALK_SECRET]: value },
    }) as (locator: unknown, name: string) => Promise<void>;
    // Playwright кладёт набранное значение в журнал вызова ошибки (`fill("…")`).
    const locator = {
      fill: async (typed: string) => {
        throw new Error(`locator.fill: Timeout 1000ms exceeded.\nCall log:\n  - fill("${typed}")`);
      },
    };
    const failure = await fillSecret(locator, WALK_SECRET).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBeDefined();
    expect(failure).not.toContain(value);
    expect(failure).toContain('fill("••••••")');
  });
});
