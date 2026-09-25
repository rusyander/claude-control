import { describe, it, expect } from 'vitest';
import { backgroundRunNotice, openRunNotice } from './runNotice';

/**
 * Каким текстом звать человека (находка 77): у каждого повода свой, и вопрос
 * ребёнка открытого чата тостом не зовут — но системным уведомлением скрытой
 * вкладки зовут.
 */
describe('backgroundRunNotice', () => {
  it('проект: вопрос, ошибка и конец — свои тексты, все с тостом', () => {
    expect(backgroundRunNotice('waiting', undefined, 'p')).toEqual({
      tone: 'warning',
      key: 'projects.notifyWaiting',
      params: { name: 'p' },
      toast: true,
    });
    expect(backgroundRunNotice('error', undefined, 'p').key).toBe('projects.notifyError');
    expect(backgroundRunNotice('idle', undefined, 'p').key).toBe('projects.notifyDone');
  });

  it('ребёнок: вопрос — без тоста, но с текстом для системы', () => {
    expect(backgroundRunNotice('waiting', { title: 'Группа 1' }, 'p')).toEqual({
      tone: 'warning',
      key: 'projects.notifyChildWaiting',
      params: { title: 'Группа 1' },
      toast: false,
    });
    expect(backgroundRunNotice('error', { title: 'g' }, 'p')).toMatchObject({
      key: 'projects.notifyChildError',
      toast: true,
    });
    expect(backgroundRunNotice('idle', { title: 'g' }, 'p')).toMatchObject({
      key: 'projects.notifyChildDone',
      toast: true,
    });
  });
});

describe('openRunNotice — повод про открытый разговор', () => {
  it('работа → конец, вопрос, ошибка', () => {
    expect(openRunNotice('running', 'idle')).toBe('projects.notifyOpenDone');
    expect(openRunNotice('running', 'waiting')).toBe('projects.notifyOpenWaiting');
    expect(openRunNotice('quiet', 'error')).toBe('projects.notifyOpenError');
  });

  it('хвост скрытой вкладки: конец из опроса, вопрос — после, из хвоста', () => {
    expect(openRunNotice('running', 'idle')).toBe('projects.notifyOpenDone');
    expect(openRunNotice('idle', 'waiting')).toBe('projects.notifyOpenWaiting');
    expect(openRunNotice('idle', 'error')).toBe('projects.notifyOpenError');
  });

  it('не повод: без перемены, начало работы, конец не из работы', () => {
    expect(openRunNotice('waiting', 'waiting')).toBeUndefined();
    expect(openRunNotice('idle', 'running')).toBeUndefined();
    expect(openRunNotice('waiting', 'idle')).toBeUndefined();
  });
});
