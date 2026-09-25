import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Один отказ — один тост (живой прогон 26.09, D2 и F4). Общий тост ошибки из
 * MutationCache (`queryClient.ts`) и тост самого вызова вставали парой: сырой
 * текст сервера рядом со своим, на языке интерфейса. Правило: если вызов
 * `.mutate(…, { onError })` показывает отказ сам, хук мутации объявляет
 * `meta: { silentError: true }`. Проверяется по исходникам всех вызовов: новый
 * вызов со своим `onError` у хука без пометки краснеет здесь.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Тело функции от объявления до следующего объявления верхнего уровня. */
function bodyOf(text: string, name: string): string | undefined {
  const start = text.search(new RegExp(`\\nexport function ${name}\\b|\\nfunction ${name}\\b`));
  if (start < 0) return undefined;
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n(export )?(function|const|interface|type) /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** Хук молчит сам или через общую обвязку, которой велено молчать. */
function silent(text: string, body: string): boolean {
  if (/silentError: true/.test(body)) return true;
  const helper = /return (use[A-Za-z]+)</.exec(body)?.[1];
  const helperBody = helper ? bodyOf(text, helper) : undefined;
  if (helperBody && /silentError: true/.test(helperBody)) return true;
  // Обвязка с параметром `silentError` и `true` последним аргументом вызова.
  return Boolean(
    helperBody && /silentError = false/.test(helperBody) && /true,\n\s*\);/.test(body),
  );
}

/** Отказ не сообщается вовсе, по замыслу: вкладку уже закрыли. */
const MUTE_BY_DESIGN = new Set(['useForgetProjectCodeView']);

describe('один отказ — один тост', () => {
  it('хук каждого вызова со своим onError глушит общий тост', () => {
    const files = sources(SRC);
    const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
    const definitions = new Map<string, string>();
    for (const [file, text] of texts) {
      for (const match of text.matchAll(/\nexport function (use[A-Za-z]+)\(/g)) {
        if (/useMutation/.test(bodyOf(text, match[1] as string) ?? '')) {
          definitions.set(match[1] as string, file);
        }
      }
    }

    const loud: string[] = [];
    const mute: string[] = [];
    let checked = 0;
    for (const [file, text] of texts) {
      for (const bind of text.matchAll(
        /const (\w+) = (use[A-Za-z]+)\((\{ silentError: true \})?\);/g,
      )) {
        const [, variable, hook, askedSilent] = bind as unknown as [
          string,
          string,
          string,
          string?,
        ];
        const home = definitions.get(hook);
        if (!home) continue;
        const homeText = texts.get(home) as string;
        const quiet = Boolean(askedSilent) || silent(homeText, bodyOf(homeText, hook) as string);
        const calls = [...text.matchAll(new RegExp(`\\b${variable}\\.mutate\\(`, 'g'))].map(
          (call) => text.slice(call.index, (call.index ?? 0) + 700),
        );
        const where = `${hook} (${file.slice(SRC.length + 1)})`;
        // Обратная сторона: тихий хук без своего onError у вызова теряет отказ совсем.
        if (quiet && !MUTE_BY_DESIGN.has(hook) && calls.some((call) => !/onError/.test(call))) {
          mute.push(where);
        }
        if (!calls.some((call) => /onError[^]*?toast\.error/.test(call))) continue;
        checked += 1;
        if (!quiet) loud.push(where);
      }
    }

    expect(checked).toBeGreaterThan(30);
    expect(loud).toEqual([]);
    expect(mute).toEqual([]);
  });
});
