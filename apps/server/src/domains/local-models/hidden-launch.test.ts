import { describe, expect, it } from 'vitest';
import { hiddenLaunchScript, psQuote } from './hidden-launch.ts';

/**
 * Скрипт запуска сервера моделей на Windows. Пути пользователя бывают с пробелами
 * и апострофами (`C:\Users\O'Brien\…`): кавычка, не удвоенная внутри строки
 * PowerShell, обрывает её, и сервер не стартует вовсе.
 */

describe('hiddenLaunchScript', () => {
  it('апостроф в пути удваивается, пробелы остаются внутри одной строки', () => {
    expect(psQuote("C:\\Users\\O'Brien\\My Apps\\ollama.exe")).toBe(
      "'C:\\Users\\O''Brien\\My Apps\\ollama.exe'",
    );
  });

  it('скрытое окно, номер процесса, вывод в журналы', () => {
    const script = hiddenLaunchScript('C:\\o\\ollama.exe', ['serve'], {
      out: 'C:\\l\\ollama.out.log',
      err: 'C:\\l\\ollama.log',
    });
    expect(script).toContain("-FilePath 'C:\\o\\ollama.exe' -ArgumentList 'serve'");
    expect(script).toContain('-WindowStyle Hidden -PassThru');
    expect(script).toContain("-RedirectStandardError 'C:\\l\\ollama.log'");
    expect(script).toContain("-RedirectStandardOutput 'C:\\l\\ollama.out.log'");
    expect(script).toMatch(/\[Console\]::Out\.Write\(\$p\.Id\)$/);
  });
});
