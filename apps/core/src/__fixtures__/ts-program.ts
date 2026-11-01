import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Полная программа TypeScript ядра для проверок по коду (P01 судьи классов, P33 каталог сигналов):
 * проверяющий TypeScript, а не текст — выведенный тип и константа ловятся там, где grep слеп.
 * `extra` — виртуальные файлы (путь от `src/` → текст): негативная проверка подкладывает
 * нарушителя, не трогая диск.
 */

export const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC = resolve(CORE, 'src');

/** Полная программа — десятки секунд под параллельными наборами, а не 20 с по умолчанию. */
export const PROGRAM_TIMEOUT_MS = 90_000;

const PARSED = new Map<string, ts.SourceFile>();

export function coreProgram(extra: Record<string, string> = {}): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(CORE, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!config) throw new Error('core tsconfig unreadable');
  const host = ts.createCompilerHost(config.options);
  const virtual = new Map(Object.entries(extra).map(([rel, text]) => [resolve(SRC, rel), text]));
  const norm = (f: string) => resolve(f);
  const baseRead = host.readFile.bind(host);
  const baseExists = host.fileExists.bind(host);
  const baseSource = host.getSourceFile.bind(host);
  host.readFile = (f) => virtual.get(norm(f)) ?? baseRead(f);
  host.fileExists = (f) => virtual.has(norm(f)) || baseExists(f);
  host.getSourceFile = (f, lang, ...rest) => {
    const text = virtual.get(norm(f));
    if (text !== undefined) return ts.createSourceFile(f, text, lang, true);
    // Разобранные файлы (lib.d.ts, типы node, ядро) общие для программ одного процесса: второй
    // разбор тех же мегабайт под общей нагрузкой выводил тест за срок, ничего не проверяя.
    const cached = PARSED.get(f);
    if (cached) return cached;
    const parsed = baseSource(f, lang, ...rest);
    if (parsed) PARSED.set(f, parsed);
    return parsed;
  };
  return ts.createProgram([...config.fileNames, ...virtual.keys()], config.options, host);
}
