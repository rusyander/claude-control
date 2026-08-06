import { describe, it, expect } from 'vitest';
import { createStreamReplacer, replaceAll } from './stream-replace.ts';

/**
 * Главная проверка модуля одна: результат НЕ ЗАВИСИТ от нарезки потока. Всё
 * остальное — частные случаи вокруг неё.
 */
const pairs = new Map([
  ['⟦ИМЯ_1⟧', 'Рустам Урманов'],
  ['⟦ТЕЛЕФОН_1⟧', '+7 900 000-00-00'],
  ['⟦ИМЯ_2⟧', 'Иван Петров'],
]);

/** Прогнать текст через поток указанными кусками. */
function stream(text: string, cuts: number[]): string {
  const replacer = createStreamReplacer(pairs);
  let out = '';
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out += replacer.push(text.slice(at, cut));
    at = cut;
  }
  out += replacer.push(text.slice(at));
  return out + replacer.flush();
}

describe('замена по потоку', () => {
  const text =
    'Здравствуйте, ⟦ИМЯ_1⟧! Ваш номер ⟦ТЕЛЕФОН_1⟧ записан. ' +
    'Копию отправим ⟦ИМЯ_2⟧, а ⟦ИМЯ_1⟧ подтвердит.';

  it('целый текст: самое левое вхождение, метки заменены все', () => {
    const whole = replaceAll(text, pairs);
    expect(whole).toContain('Рустам Урманов');
    expect(whole).toContain('+7 900 000-00-00');
    expect(whole).toContain('Иван Петров');
    expect(whole).not.toContain('⟦');
  });

  it('любая нарезка потока даёт тот же результат, что и целый текст', () => {
    const expected = replaceAll(text, pairs);
    // Каждая точка разрыва по очереди — включая разрывы ВНУТРИ метки.
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(stream(text, [cut])).toBe(expected);
    }
  });

  it('посимвольная нарезка — худший случай — тоже совпадает', () => {
    const cuts = Array.from({ length: text.length }, (_, i) => i);
    expect(stream(text, cuts)).toBe(replaceAll(text, pairs));
  });

  it('две точки разрыва в любых местах не ломают замену', () => {
    const expected = replaceAll(text, pairs);
    for (let first = 0; first <= text.length; first += 3) {
      for (let second = first; second <= text.length; second += 5) {
        expect(stream(text, [first, second])).toBe(expected);
      }
    }
  });

  it('метка, разорванная ровно посередине, собирается обратно', () => {
    const replacer = createStreamReplacer(pairs);
    const first = replacer.push('Привет, ⟦ИМЯ');
    // Начало метки наружу не выпущено — оно ещё может ею оказаться.
    expect(first).toBe('Привет, ');
    expect(first + replacer.push('_1⟧!') + replacer.flush()).toBe('Привет, Рустам Урманов!');
  });

  it('незавершённая метка в конце потока отдаётся как есть', () => {
    const replacer = createStreamReplacer(pairs);
    const out = replacer.push('оборвалось на ⟦ИМЯ_') + replacer.flush();
    expect(out).toBe('оборвалось на ⟦ИМЯ_');
  });

  it('удержание ограничено длиной самой длинной метки', () => {
    const replacer = createStreamReplacer(pairs);
    // Текст без меток проходит насквозь, ничего не копится.
    expect(replacer.push('обычный текст без меток')).toBe('обычный текст без меток');
    expect(replacer.flush()).toBe('');
  });

  it('более длинная метка побеждает более короткую с тем же началом', () => {
    const overlapping = new Map([
      ['ЛИЦО_1', 'первый'],
      ['ЛИЦО_11', 'одиннадцатый'],
    ]);
    const sample = 'тут ЛИЦО_11 и ЛИЦО_1 рядом';
    const expected = replaceAll(sample, overlapping);
    expect(expected).toBe('тут одиннадцатый и первый рядом');

    for (let cut = 0; cut <= sample.length; cut += 1) {
      const replacer = createStreamReplacer(overlapping);
      const out =
        replacer.push(sample.slice(0, cut)) + replacer.push(sample.slice(cut)) + replacer.flush();
      expect(out).toBe(expected);
    }
  });

  it('пустой список меток пропускает поток без изменений', () => {
    const replacer = createStreamReplacer(new Map());
    expect(replacer.push('что угодно') + replacer.flush()).toBe('что угодно');
  });

  it('пустые куски ничего не ломают', () => {
    const replacer = createStreamReplacer(pairs);
    const out =
      replacer.push('') +
      replacer.push('⟦ИМЯ_1⟧') +
      replacer.push('') +
      replacer.push(' и ⟦ИМЯ_2⟧') +
      replacer.flush();
    expect(out).toBe('Рустам Урманов и Иван Петров');
  });

  it('замена не рекурсивна: подставленное значение заново не ищется', () => {
    const loop = new Map([
      ['A', 'B'],
      ['B', 'A'],
    ]);
    expect(replaceAll('AB', loop)).toBe('BA');
    const replacer = createStreamReplacer(loop);
    expect(replacer.push('A') + replacer.push('B') + replacer.flush()).toBe('BA');
  });
});
