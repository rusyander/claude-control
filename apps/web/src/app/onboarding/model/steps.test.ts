import { describe, it, expect } from 'vitest';
import {
  STEP_ORDER,
  STEP_STORAGE_KEY,
  clearStoredStep,
  initialStep,
  isStep,
  nextStep,
  prevStep,
  readStoredStep,
  stepNumber,
  storeStep,
} from './steps';

/** Память вместо sessionStorage: тесты фронта идут в node, без DOM. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

describe('порядок шагов мастера', () => {
  it('четыре шага: знакомство → каталог → CLI → доступ', () => {
    expect(STEP_ORDER).toEqual(['intro', 'location', 'providers', 'access']);
  });

  it('«Далее» и «Назад» ходят по списку и упираются в края', () => {
    expect(nextStep('intro')).toBe('location');
    expect(nextStep('providers')).toBe('access');
    expect(nextStep('access')).toBeUndefined();
    expect(prevStep('access')).toBe('providers');
    expect(prevStep('intro')).toBeUndefined();
  });

  it('номер шага для счётчика — с единицы', () => {
    expect(stepNumber('intro')).toBe(1);
    expect(stepNumber('access')).toBe(STEP_ORDER.length);
  });

  it('isStep отсеивает чужие значения', () => {
    expect(isStep('location')).toBe(true);
    expect(isStep('done')).toBe(false);
    expect(isStep(undefined)).toBe(false);
  });
});

describe('с какого шага открыть мастер', () => {
  it('первый запуск без сохранённого шага — знакомство', () => {
    expect(initialStep({ onboardingDone: false, stored: null })).toBe('intro');
  });

  it('после F5 — сохранённый шаг', () => {
    expect(initialStep({ onboardingDone: false, stored: 'providers' })).toBe('providers');
  });

  it('мусор в хранилище не ломает мастер', () => {
    expect(initialStep({ onboardingDone: false, stored: 'nope' })).toBe('intro');
  });

  it('онбординг пройден, но каталог пропал — сразу шаг каталога', () => {
    // Иначе человек, давно прошедший мастер, снова видит «Добро пожаловать».
    expect(initialStep({ onboardingDone: true, stored: 'access' })).toBe('location');
  });
});

describe('память шага между перезагрузками', () => {
  it('пишет, читает и очищает по одному ключу', () => {
    const storage = memoryStorage();
    storeStep(storage, 'providers');
    expect(storage.map.get(STEP_STORAGE_KEY)).toBe('providers');
    expect(readStoredStep(storage)).toBe('providers');
    clearStoredStep(storage);
    expect(readStoredStep(storage)).toBeUndefined();
  });

  it('чужое значение в хранилище читается как «нет шага»', () => {
    expect(readStoredStep(memoryStorage({ [STEP_STORAGE_KEY]: 'garbage' }))).toBeUndefined();
  });

  it('без хранилища и при исключениях — молчит', () => {
    expect(readStoredStep(undefined)).toBeUndefined();
    expect(() => storeStep(undefined, 'intro')).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readStoredStep(broken)).toBeUndefined();
    expect(() => storeStep(broken, 'intro')).not.toThrow();
    expect(() => clearStoredStep(broken)).not.toThrow();
  });
});
