import { describe, expect, it } from 'vitest';
import { NOT_INSTALLED, playwrightFileArg, pythonFor } from './e2e-command.ts';

/**
 * F-307. Позиционный аргумент Playwright — регулярка без якорей по абсолютному
 * пути: `e2e/cart.spec.ts` прогонял и `e2e/cart.spec.tsx.spec.ts`. Живая сверка
 * с настоящим Playwright — `.agent/tmp/n1-probe/pw/probe.mts`; здесь — форма
 * аргумента для обеих оболочек.
 */
describe('playwrightFileArg', () => {
  it('экранирует точки и привязывает к концу пути', () => {
    const arg = playwrightFileArg('e2e/cart.spec.ts', 'linux');
    expect(arg).toBe(String.raw`'/(^|/)e2e/cart\.spec\.ts$/'`);
    const source = arg.slice(2, -2);
    const re = new RegExp(source);
    expect(re.test('/home/p/e2e/cart.spec.ts')).toBe(true);
    expect(re.test('/home/p/e2e/cart.spec.tsx.spec.ts')).toBe(false);
    expect(re.test('/home/p/e2e/cartXspec.ts')).toBe(false);
    expect(re.test('/home/p/other-e2e/cart.spec.ts')).toBe(false);
  });

  it('cmd — двойные кавычки и без учёта регистра; обратный слеш — разделитель', () => {
    expect(playwrightFileArg(String.raw`e2e\a (1)+.spec.ts`, 'win32')).toBe(
      String.raw`"/(^|/)e2e/a \(1\)\+\.spec\.ts$/i"`,
    );
  });

  it('одинарная кавычка в имени не рвёт кавычки sh; раскрываемое оболочкой — отказ', () => {
    expect(playwrightFileArg("e2e/it's.spec.ts", 'linux')).toBe(
      String.raw`'/(^|/)e2e/it'\''s\.spec\.ts$/'`,
    );
    expect(() => playwrightFileArg('e2e/$(x).spec.ts', 'linux')).toThrow();
  });
});

/**
 * F-312. Строка pytest зашивала `python`: на macOS и Linux его часто нет, sh
 * отвечал «not found», и вместо подсказки установки выходило «отчёт не появился».
 */
describe('pytest: интерпретатор', () => {
  it('python3 вне Windows, python на Windows', () => {
    expect(pythonFor('linux')).toBe('python3');
    expect(pythonFor('darwin')).toBe('python3');
    expect(pythonFor('win32')).toBe('python');
  });

  it('нет интерпретатора — тот же отказ «раннер не установлен»', () => {
    expect(NOT_INSTALLED.test('sh: 1: python3: not found')).toBe(true);
    expect(NOT_INSTALLED.test('/bin/sh: python3: command not found')).toBe(true);
    expect(NOT_INSTALLED.test('1 passed in 0.10s')).toBe(false);
  });
});
