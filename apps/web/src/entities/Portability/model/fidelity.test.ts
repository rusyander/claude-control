import { describe, expect, it } from 'vitest';
import {
  fidelityConditions,
  fidelityLevels,
  fidelityReasons,
} from '@agentdeck/contracts/portable-fidelity';
import { en } from '@shared/config/i18n/en';
import { ru } from '@shared/config/i18n/ru';
import {
  conditionLabelKey,
  levelLabelKey,
  reasonLabelKey,
  usableTarget,
  LEVEL_TONE,
} from './fidelity';

/**
 * СЛОВАРЬ КАНОНА И ЭКРАН НЕ РАСХОДЯТСЯ.
 *
 * Уровень закрыт типом (`Record<FidelityLevel, BadgeTone>` у `LEVEL_TONE`) — его
 * пропуск ловит сборка. А причины и условия экран берёт по строковому ключу с
 * запасным значением (`t(reasonLabelKey(row.reason), row.reason)`), и оба
 * промаха молчаливы: удалённый перевод покажет человеку английский код причины,
 * добавленная в канон причина — тот же код, и ни то ни другое не покраснеет
 * нигде. Критерий приёмки П1.1 «перевод всех причин» до этого теста держался
 * рукой.
 *
 * Проверка идёт В ОБЕ СТОРОНЫ: каждому коду канона есть перевод (ловит
 * недоделанное) и каждому переводу есть код канона (ловит выдуманное и забытое
 * после переименования).
 */

type Dictionary = Record<string, string>;

const fidelityOf = (bundle: typeof ru | typeof en): Record<string, Dictionary> =>
  bundle.portability.fidelity as unknown as Record<string, Dictionary>;

const bundles = { ru: fidelityOf(ru), en: fidelityOf(en) };

/** Ключ вида `portability.fidelity.reason.<code>` → последний сегмент. */
function leaf(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

describe('словарь верности переведён целиком и ничем сверх того', () => {
  const vocabularies = [
    { name: 'level', codes: fidelityLevels, key: levelLabelKey },
    { name: 'reason', codes: fidelityReasons, key: reasonLabelKey },
    { name: 'condition', codes: fidelityConditions, key: conditionLabelKey },
  ] as const;

  for (const [language, bundle] of Object.entries(bundles)) {
    for (const vocabulary of vocabularies) {
      it(`${language}: каждому коду ${vocabulary.name} есть непустой перевод`, () => {
        const dictionary = bundle[vocabulary.name] ?? {};
        for (const code of vocabulary.codes) {
          const text = dictionary[leaf(vocabulary.key(code as never))];
          expect(text, `${language}/${vocabulary.name}/${code}`).toBeTruthy();
        }
      });

      it(`${language}: лишних переводов ${vocabulary.name} нет — словарь закрыт`, () => {
        const dictionary = bundle[vocabulary.name] ?? {};
        expect(Object.keys(dictionary).sort()).toEqual([...vocabulary.codes].sort());
      });
    }
  }

  it('тон назначен каждому уровню: серая метка со своим кодом на экран не попадёт', () => {
    for (const level of fidelityLevels) expect(LEVEL_TONE[level]).toBeTruthy();
  });
});

/**
 * ДЕЙСТВУЮЩАЯ ЦЕЛЬ ПЕРЕНОСА.
 *
 * Сценарий, который ломался: выбрана пара «claude → codex», потом источником
 * становится сам codex. Выбранное остаётся в состоянии экрана, из списка целей
 * исчезает, запрос отчёта выключается — а страница по-прежнему считает цель
 * выбранной и рисует скелет загрузки, который не кончится никогда.
 */
describe('какая цель переноса действует при этом источнике', () => {
  const known = ['claude', 'codex', 'cursor'];

  it('цель, совпавшая с источником, не выбрана: перенос в самого себя не перенос', () => {
    expect(usableTarget('codex', 'codex', known)).toBe('');
  });

  it('цель, которой панель не знает, не выбрана: отчёт о ней всё равно не посчитать', () => {
    expect(usableTarget('aider', 'claude', known)).toBe('');
  });

  it('обычная пара остаётся как есть', () => {
    expect(usableTarget('codex', 'claude', known)).toBe('codex');
  });

  it('пустой выбор остаётся пустым и без списка провайдеров', () => {
    expect(usableTarget('', 'claude', [])).toBe('');
  });
});
