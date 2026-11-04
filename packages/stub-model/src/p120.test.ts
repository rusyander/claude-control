import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P120 держится сканером, а не памятью: проверка в `tools/qa`, которая поднимает свой
 * HTTP-сервер и отвечает на путь модельного протокола, пишет свой SSE мимо этого пакета —
 * её заглушка расходится с той, что проверяет ядро. Новое такое место — красное. Долг,
 * который был до этапа 10, перечислен поимённо и может только уменьшаться: строка списка,
 * чья проверка уже ушла на пакет, тоже красная — её надо вычеркнуть.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const QA = join(ROOT, 'tools', 'qa');

const OWN_SERVER = /\bcreateServer\s*\(|from 'node:http'|require\('(node:)?http'\)/;
const MODEL_PATH =
  /generateContent|chat\/completions|\/v1\/messages|\/v1\/responses|['"`]\/responses['"`]/;

/**
 * Долг P120 до этапа 10 (не зона заглушки Google) — только вычёркивается.
 * `check-foreign-group-watch.mjs` вычеркнут: проверка снята вместе с прежним сторожем групп
 * чужих CLI (этап 10, F5), её путь в продукте ушёл — в архиве, своего сервера больше нет.
 */
const DEBT = new Set([
  'tools/qa/check-codex-gateway.mjs',
  'tools/qa/check-platform-foreign.mjs',
  'tools/qa/check-platform-wire.mjs',
]);

/**
 * Проверки Gemini, переведённые на пакет на этапе 10: своего сервера у них нет навсегда.
 * Сняты вместе со своим путём в продукте, в архиве, не здесь: `check-panel-agent-gemini.mjs`
 * (агент панели на Gemini — ядро даёт сессию с одним мостом только Claude и Qwen Code) и
 * `check-cli-gemini.mjs` (вёл чат по снятым маршрутам провайдеров, 410). Его намерение держит
 * строка gemini в `check-run-endpoint-cli.mjs` на пути ядра.
 */
const MOVED = ['tools/qa/check-run-endpoint-cli.mjs'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : files(full);
    return /\.(mjs|js|ts)$/.test(name) ? [full] : [];
  });
}

const rel = (file: string) => relative(ROOT, file).replace(/\\/g, '/');

export function ownModelStub(source: string): boolean {
  return OWN_SERVER.test(source) && MODEL_PATH.test(source);
}

describe('P120 — QA model stubs go through @agentdeck/stub-model', () => {
  const offenders = files(QA)
    .filter((file) => ownModelStub(readFileSync(file, 'utf8')))
    .map(rel);

  it('no QA check outside the named debt answers a model protocol with its own server', () => {
    expect(offenders.filter((file) => !DEBT.has(file))).toEqual([]);
  });

  it('the debt list only shrinks: an entry whose check moved to the package is struck out', () => {
    expect([...DEBT].filter((file) => !offenders.includes(file))).toEqual([]);
  });

  it('the Gemini checks moved in stage 10 import the package and hold no server of their own', () => {
    for (const file of MOVED) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(OWN_SERVER.test(source), file).toBe(false);
      expect(source, file).toContain('packages/stub-model/src/index.mjs');
    }
  });

  it('the scanner itself flags a hand-rolled SSE model server and passes a package scenario', () => {
    expect(
      ownModelStub(
        "import { createServer } from 'node:http';\nif (req.url.includes('/v1/chat/completions')) {}",
      ),
    ).toBe(true);
    expect(
      ownModelStub("import { startStubModel } from '../../packages/stub-model/src/index.mjs';"),
    ).toBe(false);
  });
});
