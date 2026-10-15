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

/**
 * Настоящий путь Windows: PowerShell `Start-Process -ArgumentList` склеивает элементы
 * пробелом КАК ЕСТЬ, а процесс разбирает строку по правилам CommandLineToArgvW. Без
 * своих кавычек JSON `--chat-template-kwargs` теряет `"` и сервер не стартует, путь с
 * пробелом рвётся на два аргумента. Запускается node, который пишет свой argv в файл.
 */
describe.runIf(process.platform === 'win32')('launchHidden: аргументы доходят как есть', () => {
  it('JSON с кавычками, путь с пробелом, обратные косые перед кавычкой и в конце', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { launchHidden } = await import('./hidden-launch.ts');
    const dir = mkdtempSync(join(tmpdir(), 'hidden launch '));
    const out = join(dir, 'argv.json');
    const script = join(dir, 'dump.cjs');
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const args = [
      '--chat-template-kwargs',
      '{"reasoning_effort":"medium"}',
      '-m',
      'C:\\Models dir\\Qwen 3.8\\model.gguf',
      'trailing dir\\',
      'quote\\"inside',
      'plain',
    ];
    await launchHidden(process.execPath, [script, ...args], process.env, {
      out: join(dir, 'out.log'),
      err: join(dir, 'err.log'),
    });
    for (let waited = 0; waited < 15_000 && !existsSync(out); waited += 100)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(args);
  }, 30_000);
});
