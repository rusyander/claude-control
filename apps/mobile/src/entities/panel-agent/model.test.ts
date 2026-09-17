import { describe, expect, it } from 'vitest';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import {
  appendDictation,
  canApprove,
  cardFields,
  decisionProblem,
  isDanger,
  isFinalRefusal,
  phoneContext,
} from './model';

const texts = {
  truncated: 'truncated',
  alreadyDecided: 'already',
  gone: 'gone',
  failed: (message: string) => `failed: ${message}`,
};

const pending = (extra: Partial<PanelPendingAction> = {}): PanelPendingAction => ({
  id: 'p1',
  name: 'create_project',
  risk: 'change',
  preview: {
    summary: 'Создать проект',
    fields: [
      { label: 'Каталог', value: 'C:/work/demo' },
      { label: 'Промпт', value: 'строка\nвторая' },
    ],
  },
  createdAt: '2026-09-17T10:00:00.000Z',
  expiresAt: '2026-09-17T10:10:00.000Z',
  ...extra,
});

describe('агент панели на телефоне', () => {
  it('контекст честно говорит модели, что это телефон, и несёт проект', () => {
    const context = phoneContext('C:/work/demo');
    expect(context.route).toBe('phone');
    expect(context.title).toMatch(/Phone app/);
    expect(context.projectPath).toBe('C:/work/demo');
    expect(phoneContext()).not.toHaveProperty('projectPath');
  });

  it('отказ сервера решению с телефона назван словами, а не статусом', () => {
    // Особого «решите на компьютере» больше нет: 403 — текст сервера как есть.
    expect(
      decisionProblem({ status: 403, code: 'decision_not_allowed', message: 'нельзя' }, texts),
    ).toBe('failed: нельзя');
    expect(decisionProblem({ status: 409, code: 'preview_truncated' }, texts)).toBe('truncated');
    expect(decisionProblem({ status: 409, code: 'already_decided' }, texts)).toBe('already');
    expect(decisionProblem({ status: 404 }, texts)).toBe('gone');
    expect(decisionProblem({ status: 0, message: 'offline' }, texts)).toBe('failed: offline');
    expect(isFinalRefusal({ status: 409 })).toBe(true);
    expect(isFinalRefusal({ status: 403 })).toBe(false);
  });

  it('поля карточки целиком, многострочное — в прокрутке', () => {
    const fields = cardFields(pending());
    expect(fields[0]).toEqual({ label: 'Каталог', value: 'C:/work/demo', long: false });
    expect(fields[1]?.long).toBe(true);
    expect(fields[1]?.value).toBe('строка\nвторая');
  });

  it('опасная карточка и неполный предпросмотр распознаются', () => {
    expect(isDanger(pending({ risk: 'danger' }))).toBe(true);
    expect(isDanger(pending())).toBe(false);
    expect(canApprove(pending())).toBe(true);
    expect(canApprove(pending({ preview: { summary: 's', fields: [], truncated: true } }))).toBe(
      false,
    );
  });

  it('надиктованное дописывается к набранному и само не отправляется', () => {
    expect(appendDictation('', 'создай проект')).toBe('создай проект');
    expect(appendDictation('Перейди в чат,', ' создай проект')).toBe(
      'Перейди в чат, создай проект',
    );
    expect(appendDictation('текст', '  ')).toBe('текст');
  });
});
