import { describe, it, expect } from 'vitest';
import { runnerStartOffer } from './runnerStart';

/**
 * Пустой пульт ручного прохода был тупиком: «начните из библиотеки» — и ни
 * одной кнопки. Предложение начать тут же берёт то, что начала бы кнопка
 * «Пройти руками» в библиотеке: отмеченные кейсы, а без отметок — видимые
 * в выбранной группе.
 */
describe('runnerStartOffer', () => {
  const groups = [
    { id: 'gui', title: 'GUI' },
    { id: 'api', title: 'API' },
  ];

  it('отмеченные кейсы важнее видимых', () => {
    expect(runnerStartOffer({ groups, activeId: 'gui', checked: ['a', 'b'], visible: 7 })).toEqual({
      groupTitle: 'GUI',
      count: 2,
    });
  });

  it('без отметок — все видимые в группе', () => {
    expect(runnerStartOffer({ groups, activeId: 'api', checked: [], visible: 5 })).toEqual({
      groupTitle: 'API',
      count: 5,
    });
  });

  it('группа не выбрана или проходить нечего — предложения нет', () => {
    expect(runnerStartOffer({ groups, activeId: '', checked: [], visible: 5 })).toBeUndefined();
    expect(runnerStartOffer({ groups, activeId: 'gui', checked: [], visible: 0 })).toBeUndefined();
    expect(runnerStartOffer({ groups, activeId: 'gone', checked: [], visible: 3 })).toBeUndefined();
  });
});
