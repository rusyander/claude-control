import { describe, it, expect } from 'vitest';
import { runAssignment } from './runAssignment';

/**
 * Шапка лёгкого чата вопроса о ходе групп (5.1): до конца первого хода чата нет
 * в списке, и модель с глубиной шапка берёт у живого прогона, а не из настроек.
 */
describe('runAssignment', () => {
  it('прогон без строки в списке — его модель и глубина', () => {
    expect(runAssignment(undefined, { model: 'sonnet', effort: 'medium' })).toEqual({
      assignedModel: 'sonnet',
      effort: 'medium',
    });
  });

  it('прогон без глубины — только модель', () => {
    expect(runAssignment(undefined, { model: 'sonnet' })).toEqual({ assignedModel: 'sonnet' });
  });

  it('разговор из списка главнее прогона', () => {
    const chat = { assignedModel: 'claude-haiku-4-5', effort: 'low' };
    expect(runAssignment(chat, { model: 'sonnet', effort: 'medium' })).toBe(chat);
  });

  it('черновик без прогона — назначенного нет, шапка берёт настройки', () => {
    expect(runAssignment(undefined, {})).toBeUndefined();
  });
});
