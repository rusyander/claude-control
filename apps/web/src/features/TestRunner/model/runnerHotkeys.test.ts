import { describe, expect, it, vi } from 'vitest';
import {
  RUNNER_ATTACH_KEY,
  RUNNER_NOTE_KEY,
  RUNNER_VERDICTS,
  runnerBindings,
} from './runnerHotkeys';

/**
 * Клавиши ручного прохода. Проверяется то, чем клавиатура опасна: чтобы цифра
 * закрывала ИМЕННО тот вердикт, что написан под ней на кнопке, чтобы в полях
 * ввода ничего не срабатывало и чтобы у закрытого окна привязок не оставалось.
 */
const actionsOf = () => ({
  submit: vi.fn(),
  prev: vi.fn(),
  next: vi.fn(),
  focusNote: vi.fn(),
  attach: vi.fn(),
});

const press = (bindings: ReturnType<typeof runnerBindings>, chord: string): void => {
  bindings.find((item) => item.chord === chord)?.handler();
};

describe('runnerBindings', () => {
  it('прохода нет — привязок нет вовсе', () => {
    expect(runnerBindings(actionsOf(), false)).toEqual([]);
  });

  it('цифра закрывает вердикт, стоящий на кнопке с тем же номером', () => {
    const actions = actionsOf();
    const bindings = runnerBindings(actions, true);

    RUNNER_VERDICTS.forEach((verdict, index) => {
      press(bindings, String(index + 1));
      expect(actions.submit).toHaveBeenLastCalledWith(verdict);
    });
    expect(actions.submit).toHaveBeenCalledTimes(RUNNER_VERDICTS.length);
  });

  it('заметка и снимок идут сразу за вердиктами', () => {
    const actions = actionsOf();
    const bindings = runnerBindings(actions, true);

    press(bindings, RUNNER_NOTE_KEY);
    press(bindings, RUNNER_ATTACH_KEY);

    expect(actions.focusNote).toHaveBeenCalledTimes(1);
    expect(actions.attach).toHaveBeenCalledTimes(1);
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it('стрелки листают проходы, ничего не отправляя', () => {
    const actions = actionsOf();
    const bindings = runnerBindings(actions, true);

    press(bindings, 'arrowleft');
    press(bindings, 'arrowright');

    expect(actions.prev).toHaveBeenCalledTimes(1);
    expect(actions.next).toHaveBeenCalledTimes(1);
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it('ни одна клавиша не работает в поле ввода', () => {
    const bindings = runnerBindings(actionsOf(), true);
    expect(bindings.every((item) => !item.allowInInput)).toBe(true);
  });

  it('клавиши не пересекаются между собой', () => {
    const bindings = runnerBindings(actionsOf(), true);
    expect(new Set(bindings.map((item) => item.chord)).size).toBe(bindings.length);
  });
});
