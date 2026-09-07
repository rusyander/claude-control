import { describe, it, expect } from 'vitest';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { fromCase, toInput, type CaseDraft } from './useCaseDraft';

/**
 * Форма кейса — единственное место, где человек пишет тест руками, и её вход и
 * выход обязаны сходиться: то, что открыли на правку, после сохранения должно
 * остаться тем же кейсом, а не потерять половину полей по дороге.
 */
describe('fromCase', () => {
  it('пустой кейс даёт чистый черновик с шагом-заготовкой', () => {
    const draft = fromCase(undefined);
    expect(draft.id).toBeUndefined();
    expect(draft.type).toBe('case');
    expect(draft.priority).toBe('medium');
    expect(draft.readiness).toBe('draft');
    expect(draft.automationStatus).toBe('manual');
    expect(draft.steps).toEqual([{ action: '' }]);
    expect(draft.duration).toBe('');
  });

  it('переносит все поля кейса и склеивает теги строкой', () => {
    const testCase: ProjectTestCase = {
      id: 'chat-send',
      type: 'case',
      title: 'Отправка',
      purpose: 'проверить отправку',
      area: 'чат',
      section: 'Чат/Отправка',
      precondition: 'вход выполнен',
      steps: [{ action: 'нажать', expected: 'ушло' }],
      expected: 'сообщение в списке',
      postcondition: 'очистить',
      oracle: 'лог сервера',
      priority: 'blocker',
      readiness: 'ready',
      duration: 5,
      tags: ['smoke', 'chat'],
      links: [{ type: 'issue', url: 'https://tracker/1', title: 'PRJ-1' }],
      attributes: { layer: 'ui' },
      parameters: [{ name: 'role', values: ['admin', 'user'] }],
      attachments: ['shot.png'],
      automation: { status: 'automated', file: 'e2e/chat.spec.ts', testName: 'send' },
      archived: true,
      status: 'passed',
      source: 'human',
    };

    const draft = fromCase(testCase);
    expect(draft.tags).toBe('smoke, chat');
    expect(draft.duration).toBe('5');
    expect(draft.automationFile).toBe('e2e/chat.spec.ts');
    expect(draft.archived).toBe(true);
    expect(draft.parameters).toEqual([{ name: 'role', values: ['admin', 'user'] }]);

    // Копия, а не тот же объект: правка формы не должна менять список за спиной.
    draft.parameters[0]?.values.push('guest');
    draft.steps[0]!.action = 'другое';
    expect(testCase.parameters?.[0]?.values).toEqual(['admin', 'user']);
    expect(testCase.steps[0]?.action).toBe('нажать');
  });

  it('кейс без шагов всё равно открывается с одной пустой строкой', () => {
    const draft = fromCase({
      id: 'a',
      title: 'a',
      steps: [],
      status: 'unknown',
      source: 'human',
      type: 'checklist',
    });
    expect(draft.steps).toEqual([{ action: '' }]);
    expect(draft.type).toBe('checklist');
  });
});

const draftOf = (part: Partial<CaseDraft> = {}): CaseDraft => ({ ...fromCase(undefined), ...part });

describe('toInput', () => {
  it('обрезает поля, разбирает теги и выкидывает пустые шаги', () => {
    const input = toInput(
      draftOf({
        title: '  Отправка  ',
        purpose: ' цель ',
        tags: 'smoke, , chat ',
        steps: [
          { action: '  нажать  ', expected: '  ушло  ', data: ' x ' },
          { action: '   ' },
          { action: '', ref: ' shared-login ' },
        ],
      }),
    );

    expect(input.title).toBe('Отправка');
    expect(input.purpose).toBe('цель');
    expect(input.tags).toEqual(['smoke', 'chat']);
    expect(input.steps).toEqual([
      { action: 'нажать', expected: 'ушло', data: 'x' },
      { action: '', ref: 'shared-login' },
    ]);
  });

  it('чек-лист сохраняется без ожиданий, условий и оракула', () => {
    const input = toInput(
      draftOf({
        type: 'checklist',
        precondition: 'вход',
        expected: 'что-то',
        postcondition: 'выход',
        oracle: 'лог',
      }),
    );
    expect(input.precondition).toBe('');
    expect(input.expected).toBe('');
    expect(input.postcondition).toBe('');
    expect(input.oracle).toBe('');
  });

  it('обычный кейс эти поля сохраняет', () => {
    const input = toInput(draftOf({ precondition: ' вход ', expected: ' готово ' }));
    expect(input.precondition).toBe('вход');
    expect(input.expected).toBe('готово');
  });

  it('оценка длительности уходит только числом больше нуля', () => {
    expect(toInput(draftOf({ duration: '' })).duration).toBeUndefined();
    expect(toInput(draftOf({ duration: 'десять' })).duration).toBeUndefined();
    expect(toInput(draftOf({ duration: '0' })).duration).toBeUndefined();
    expect(toInput(draftOf({ duration: '7' })).duration).toBe(7);
  });

  it('ссылки без адреса и параметры без имени или значений не сохраняются', () => {
    const input = toInput(
      draftOf({
        links: [
          { type: 'issue', url: 'https://tracker/1', title: 'PRJ-1' },
          { type: 'doc', url: '   ', title: 'пусто' },
        ],
        parameters: [
          { name: 'role', values: ['admin'] },
          { name: '  ', values: ['x'] },
          { name: 'env', values: [] },
        ],
      }),
    );
    expect(input.links).toEqual([{ type: 'issue', url: 'https://tracker/1', title: 'PRJ-1' }]);
    expect(input.parameters).toEqual([{ name: 'role', values: ['admin'] }]);
  });

  it('идентификатор уходит только у существующего кейса', () => {
    expect(toInput(draftOf({})).id).toBeUndefined();
    expect(toInput(draftOf({ id: 'chat-send' })).id).toBe('chat-send');
  });

  it('черновик кейса и обратный разбор сходятся', () => {
    const input = toInput(
      draftOf({
        id: 'a',
        title: 'Отправка',
        tags: 'smoke',
        duration: '3',
        steps: [{ action: 'нажать' }],
        automationStatus: 'automated',
        automationFile: 'e2e/a.spec.ts',
        automationTestName: 'send',
      }),
    );

    // Во входном формате шаг разрешено писать строкой, в самом кейсе он всегда
    // объект — на этой границе и сходятся форма с файлом.
    const again = fromCase({
      ...input,
      id: 'a',
      type: 'case',
      steps: input.steps.map((step) => (typeof step === 'string' ? { action: step } : step)),
      status: 'unknown',
      source: 'human',
    });
    expect(again.tags).toBe('smoke');
    expect(again.duration).toBe('3');
    expect(again.automationStatus).toBe('automated');
    expect(again.steps).toEqual([{ action: 'нажать' }]);
  });
});
