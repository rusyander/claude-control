/**
 * Сбой записи ввода ядра на границе файловой системы: `appendFileSync` строки `send` в
 * `core-io.jsonl` падает столько раз, сколько велено. Насос, диалект, хост и вид сеанса над этим —
 * настоящие. Подключается из файла теста:
 *   vi.mock('node:fs', async (orig) =>
 *     (await import('./__fixtures__/io-fault.ts')).faultyFs(await orig()));
 * Модуль сам `node:fs` не импортирует — иначе фабрика мока зациклилась бы на себе.
 */

export const ioFault = { sends: 0 };

type AppendFileSync = (path: unknown, data: unknown, options?: unknown) => void;

export function faultyFs<T extends object>(module: T): T {
  const fs = module as unknown as { appendFileSync: AppendFileSync };
  const append: AppendFileSync = (path, data, options) => {
    const sendLine = typeof data === 'string' && data.includes('"t":"send"');
    if (ioFault.sends > 0 && String(path).endsWith('core-io.jsonl') && sendLine) {
      ioFault.sends -= 1;
      throw Object.assign(new Error('EIO: injected core-io append failure'), { code: 'EIO' });
    }
    fs.appendFileSync(path, data, options);
  };
  return { ...module, appendFileSync: append };
}
