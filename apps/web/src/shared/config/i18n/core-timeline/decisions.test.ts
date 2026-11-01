import { describe, expect, it } from 'vitest';
import { DECISION_OUTCOMES } from '@agentdeck/contracts/core/decision-view';
import { decisionsEn } from './decisions.en.ts';
import { decisionsRu } from './decisions.ru.ts';

/**
 * Шаблоны решений (F1) — исчерпывающие в обе стороны: каждый класс и исход реестра ядра имеет
 * подпись и заголовок на обоих языках, и в шаблонах нет класса или исхода, которого реестр не
 * знает (устаревший шаблон молча висел бы мёртвым текстом). Тип `DecisionTexts` ловит то же при
 * сборке; тест — на случай, если тип ослабят.
 */

const REGISTRY = DECISION_OUTCOMES as Record<string, readonly string[]>;

describe.each([
  ['ru', decisionsRu],
  ['en', decisionsEn],
] as const)('шаблоны решений %s', (_lang, texts) => {
  const table = texts as Record<string, { label: string; outcomes: Record<string, string> }>;

  it('каждый класс реестра — непустая подпись и заголовок каждого исхода', () => {
    for (const [cls, outcomes] of Object.entries(REGISTRY)) {
      expect(table[cls]?.label, cls).toBeTruthy();
      for (const outcome of outcomes) {
        expect(table[cls]?.outcomes[outcome], `${cls}.${outcome}`).toBeTruthy();
      }
    }
  });

  it('лишних классов и исходов нет', () => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(REGISTRY).sort());
    for (const [cls, entry] of Object.entries(table)) {
      expect(Object.keys(entry.outcomes).sort(), cls).toEqual([...REGISTRY[cls]!].sort());
    }
  });
});
