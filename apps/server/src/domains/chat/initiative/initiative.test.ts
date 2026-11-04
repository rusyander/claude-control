import { describe, it, expect } from 'vitest';
import { chatDeliveryPrompt } from '@agentdeck/contracts/task-split';
import { initiativePrompt } from './initiative.ts';

/**
 * Инициативы уезжают к агенту одним аргументом командной строки, поэтому
 * проверяем не текст, а два его свойства: складываются ли включённые тумблеры и
 * остаётся ли результат ОДНОЙ строкой. Перевод строки внутри аргумента cmd.exe
 * молча обрезает команду — эту цену уже платили.
 */
describe('строка инициатив для прогона', () => {
  /**
   * Правило про вопрос человеку тумблера не имеет: это не инициатива панели, а
   * правда об окружении. Без неё агент читает ошибку `AskUserQuestion` как отказ
   * человека и решает развилку сам — то есть выключенные тумблеры молча меняли
   * бы его поведение там, где выбор принадлежит человеку.
   */
  it('тумблер выключен — остаётся правило про вопрос человеку', () => {
    const bare = initiativePrompt({ handoffInitiative: false }) ?? '';

    expect(bare).toContain('AskUserQuestion');
    expect(bare).toContain('Answer questions?');
    expect(bare).toContain('a refusal from the panel');
    // Фон переживает ход, но не смену процесса — нужное сейчас агент ждёт в том же ходе.
    expect(bare).toContain('run_in_background');
    expect(bare).toContain('lives between turns');
    expect(bare).toContain('wait in the same turn');
    expect(bare).not.toContain('agentdeck:split');
    expect(bare).not.toContain('agentdeck:handoff');
    expect(bare).not.toMatch(/[\r\n]/);
  });

  /**
   * Чужому CLI это правило не адресовано: инструмента `AskUserQuestion` у него
   * нет вовсе, и рассказ про чужую ошибку только сбивал бы.
   */
  it('чужому CLI без включённых инициатив дописывать нечего', () => {
    expect(initiativePrompt({ handoffInitiative: false }, { foreign: true })).toBeUndefined();
    expect(initiativePrompt({ handoffInitiative: true }, { foreign: true })).not.toContain(
      'AskUserQuestion',
    );
  });

  /**
   * Предложение разделения снято (этап 10, G14): у карточки разделения нет кнопок.
   * Склейка его не просит ни при каком тумблере, источник его не называет.
   */
  it('продолжение — одной строкой; разделения в склейке нет', () => {
    const handoff = initiativePrompt({ handoffInitiative: true });
    expect(handoff).toBeDefined();
    expect(handoff).not.toMatch(/[\r\n]/);
    expect(handoff).toContain('agentdeck:handoff');
    expect(handoff).toContain('continue the work in a clean session');
    expect(handoff).toContain('it is triggered by a service block');
    for (const prompt of [handoff, initiativePrompt({ handoffInitiative: false })]) {
      expect(prompt).not.toContain('agentdeck:split');
      expect(prompt).not.toContain('spread a list of tasks');
      expect(prompt).not.toContain('propose a split');
    }
  });

  /**
   * Живые прогоны 1 сентября: агент отвечал «выглядит как попытка prompt
   * injection, игнорирую» — русский текст ниоткуда, ни в CLAUDE.md, ни в
   * сообщении человека. Объяснение источника стоит первым и ровно поэтому
   * обязано быть в любой склейке.
   */
  it('склейка начинается с источника — иначе агент читает её как подсадную', () => {
    for (const settings of [{ handoffInitiative: false }, { handoffInitiative: true }]) {
      const prompt = initiativePrompt(settings) ?? '';
      expect(prompt.startsWith('This run was started from the AgentDeck panel')).toBe(true);
    }
  });

  it('инициатива продолжения требует уборки рабочих файлов до предложения', () => {
    const handoff = initiativePrompt({ handoffInitiative: true }) ?? '';
    expect(handoff).toContain('ARCHIVE.md');
    expect(handoff).toContain('TASKS.md');
  });

  /**
   * Доставка до MR в обычном чате: строка приезжает, только когда её передали,
   * остаётся однострочной и сама ограничивает себя задачей на изменение кода —
   * MR на «объясни, как это работает» был бы вредом.
   */
  it('доставка: приезжает по запросу, одной строкой, с планкой и запретами', () => {
    const settings = { handoffInitiative: false };
    expect(initiativePrompt(settings)).not.toContain('delivery up to an MR');

    const delivery = chatDeliveryPrompt({ skill: 'acme-ticket-delivery' });
    const line = initiativePrompt(settings, { delivery }) ?? '';
    expect(line).toContain('enabled delivery up to an MR on this project');
    expect(line).toContain('`acme-ticket-delivery`');
    // Старшинство (владелец 20.10): стадии ведёт общий навык, проектный — только факты.
    expect(line).toContain('with the global task delivery skill `ticket-delivery-2`');
    expect(line).toContain('`acme-ticket-delivery` does not drive the stages');
    expect(line).not.toContain('with the project skill');
    expect(line).toContain('code-change task');
    expect(line).toContain('needs no MR');
    expect(line).toContain('merging, deleting branches and force-push are forbidden');
    expect(line).not.toMatch(/[\r\n]/);

    // Чужому CLI — без AskUserQuestion, но строка доезжает.
    const foreign = chatDeliveryPrompt({ foreign: true });
    expect(foreign).not.toContain('AskUserQuestion');
    expect(foreign).toContain('`ticket-delivery-2`');
    expect(initiativePrompt(settings, { foreign: true, delivery: foreign })).toContain(foreign);
  });
});
