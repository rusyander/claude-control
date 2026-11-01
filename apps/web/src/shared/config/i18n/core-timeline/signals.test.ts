import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SIGNAL_FACT_KEYS,
  SIGNAL_IDS,
  SIGNAL_SUBJECTS,
} from '@agentdeck/contracts/core/signal-view';
import { signalsEn } from './signals.en.ts';
import { signalsRu } from './signals.ru.ts';

/**
 * Шаблоны сигналов — исчерпывающие в обе стороны, и список контрактов совпадает с каталогом ядра.
 * Панель не импортирует ядро (depcruise `panel-apart-from-core`), поэтому каталог читается текстом
 * файла: id записей `emitted('<id>'` и `id: '<id>'` — та же опись, по которой `catalog.test` ядра
 * держит полноту. Сигнал, добавленный в каталог без строки в `SIGNAL_VIEW` и шаблона, краснеет здесь.
 */

const CATALOG = new URL('../../../../../../core/src/observer/catalog.ts', import.meta.url);

function catalogIds(): string[] {
  const text = readFileSync(CATALOG, 'utf8');
  const ids = new Set<string>();
  for (const m of text.matchAll(/emitted\(\s*'([a-z][a-z-]*)'/g)) ids.add(m[1]!);
  for (const m of text.matchAll(/\bid: '([a-z][a-z-]*)'/g)) ids.add(m[1]!);
  return [...ids].sort();
}

describe('список сигналов контрактов = каталог ядра', () => {
  it('каждый id каталога есть в SIGNAL_VIEW, и лишних нет', () => {
    const ids = catalogIds();
    // Пустая опись (каталог переехал, разметка сменилась) прошла бы сверку молча.
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect([...SIGNAL_IDS].sort()).toEqual(ids);
  });
});

describe.each([
  ['ru', signalsRu],
  ['en', signalsEn],
] as const)('шаблоны сигналов %s', (_lang, texts) => {
  const titles = texts.titles as Record<string, string>;
  const subjects = texts.subjects as Record<string, string>;
  const facts = texts.facts as Record<string, string>;

  it('каждый сигнал каталога — непустой заголовок', () => {
    for (const id of SIGNAL_IDS) expect(titles[id], id).toBeTruthy();
  });

  it('каждый вид предмета и каждый факт — непустая подпись', () => {
    for (const s of SIGNAL_SUBJECTS) expect(subjects[s], s).toBeTruthy();
    for (const f of SIGNAL_FACT_KEYS) expect(facts[f], f).toBeTruthy();
  });

  it('лишних шаблонов нет', () => {
    expect(Object.keys(titles).sort()).toEqual([...SIGNAL_IDS].sort());
    expect(Object.keys(subjects).sort()).toEqual([...SIGNAL_SUBJECTS].sort());
    expect(Object.keys(facts).sort()).toEqual([...SIGNAL_FACT_KEYS].sort());
  });
});
