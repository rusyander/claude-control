import { describe, it, expect } from 'vitest';
import { chatDeliveryPrompt } from '@agentdeck/contracts/task-split';
import { DELIVERY_AFTER_SPLIT, initiativePrompt } from './initiative.ts';

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
  it('оба тумблера выключены — остаётся правило про вопрос человеку', () => {
    const bare = initiativePrompt({ taskSplitInitiative: false, handoffInitiative: false }) ?? '';

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
    expect(
      initiativePrompt({ taskSplitInitiative: false, handoffInitiative: false }, { foreign: true }),
    ).toBeUndefined();
    expect(
      initiativePrompt({ taskSplitInitiative: true, handoffInitiative: false }, { foreign: true }),
    ).not.toContain('AskUserQuestion');
  });

  it('включённые складываются в одну строку без переводов строки', () => {
    const both = initiativePrompt({ taskSplitInitiative: true, handoffInitiative: true });
    expect(both).toBeDefined();
    expect(both).not.toMatch(/[\r\n]/);
    expect(both).toContain('agentdeck:split');
    expect(both).toContain('agentdeck:handoff');
  });

  it('каждый тумблер отвечает только за свою инициативу', () => {
    const split = initiativePrompt({ taskSplitInitiative: true, handoffInitiative: false });
    expect(split).toContain('agentdeck:split');
    expect(split).not.toContain('agentdeck:handoff');

    const handoff = initiativePrompt({ taskSplitInitiative: false, handoffInitiative: true });
    expect(handoff).toContain('agentdeck:handoff');
    expect(handoff).not.toContain('agentdeck:split');
  });

  /**
   * Живые прогоны 1 сентября: агент отвечал «выглядит как попытка prompt
   * injection, игнорирую» — русский текст ниоткуда, ни в CLAUDE.md, ни в
   * сообщении человека. Объяснение источника стоит первым и ровно поэтому
   * обязано быть в любой склейке.
   */
  it('склейка начинается с источника — иначе агент читает её как подсадную', () => {
    for (const settings of [
      { taskSplitInitiative: true, handoffInitiative: false },
      { taskSplitInitiative: false, handoffInitiative: true },
      { taskSplitInitiative: true, handoffInitiative: true },
    ]) {
      const prompt = initiativePrompt(settings) ?? '';
      expect(prompt.startsWith('This run was started from the AgentDeck panel')).toBe(true);
    }
  });

  it('инициатива продолжения требует уборки рабочих файлов до предложения', () => {
    const handoff = initiativePrompt({ taskSplitInitiative: false, handoffInitiative: true }) ?? '';
    expect(handoff).toContain('ARCHIVE.md');
    expect(handoff).toContain('TASKS.md');
  });
  /**
   * Инициатива дописывается к КАЖДОМУ прогону, поэтому без глушителя агент
   * предлагает делить снова и снова — живые прогоны спрашивали об этом даже на
   * «убери лишние импорты в трёх файлах». Отказались или уже разделили —
   * инструкция уезжать перестаёт, а продолжение в чистой сессии остаётся: это
   * другой тумблер и другое решение.
   */
  it('разговор с погашенным разделением получает только продолжение', () => {
    const both = { taskSplitInitiative: true, handoffInitiative: true };
    const muted = initiativePrompt(both, { splitMuted: true }) ?? '';

    expect(muted).not.toContain('agentdeck:split');
    expect(muted).toContain('agentdeck:handoff');
    expect(muted.startsWith('This run was started from the AgentDeck panel')).toBe(true);
  });

  it('единственная инициатива погашена — у чужого CLI строки нет вовсе', () => {
    expect(
      initiativePrompt(
        { taskSplitInitiative: true, handoffInitiative: false },
        { splitMuted: true, foreign: true },
      ),
    ).toBeUndefined();
  });

  /**
   * Планка «что считать отдельной задачей» — не украшение: именно её занижение
   * превращало инициативу в назойливость.
   */
  it('в инструкции названа планка задачи и запрет спрашивать дважды', () => {
    const split = initiativePrompt({ taskSplitInitiative: true, handoffInitiative: false }) ?? '';
    expect(split).toContain('ONE task');
    expect(split).toContain('at most once per conversation');
  });

  /**
   * Доставка до MR в обычном чате: строка приезжает, только когда её передали,
   * остаётся однострочной и сама ограничивает себя задачей на изменение кода —
   * MR на «объясни, как это работает» был бы вредом.
   */
  it('доставка: приезжает по запросу, одной строкой, с планкой и запретами', () => {
    const settings = { taskSplitInitiative: false, handoffInitiative: false };
    expect(initiativePrompt(settings)).not.toContain('delivery up to an MR');

    const delivery = chatDeliveryPrompt({ skill: 'acme-ticket-delivery' });
    const line = initiativePrompt(settings, { delivery }) ?? '';
    expect(line).toContain('enabled delivery up to an MR on this project');
    expect(line).toContain('`acme-ticket-delivery`');
    expect(line).toContain('code-change task');
    expect(line).toContain('needs no MR');
    expect(line).toContain('merging, deleting branches and force-push are forbidden');
    expect(line).not.toMatch(/[\r\n]/);

    // Чужому CLI — без AskUserQuestion, но строка доезжает.
    const foreign = chatDeliveryPrompt({ foreign: true });
    expect(foreign).not.toContain('AskUserQuestion');
    expect(foreign).toContain('`ticket-delivery`');
    expect(initiativePrompt(settings, { foreign: true, delivery: foreign })).toContain(foreign);
  });

  /**
   * Живой прогон 24.09.2026: родитель получил и «предложи разделение», и
   * «доставь до MR» без старшинства — и мог доставить пять тикетов сам.
   * Доставка остаётся (разделение включено из коробки, чат с одной задачей
   * без неё не дошёл бы до MR), но уступает разделению явно.
   */
  it('доставка рядом с разделением уступает ему; без разделения — как была', () => {
    const delivery = chatDeliveryPrompt({ skill: 'acme-ticket-delivery' });
    const split = { taskSplitInitiative: true, handoffInitiative: false };

    const both = initiativePrompt(split, { delivery }) ?? '';
    expect(both).toContain(`${DELIVERY_AFTER_SPLIT} ${delivery}`);
    expect(both).toContain('if you propose a split, deliver nothing');
    expect(both).toContain('enabled delivery up to an MR on this project');
    expect(both).not.toMatch(/[\r\n]/);

    // Разделение уже предлагали — старшинство не нужно, строка доставки чистая.
    const muted = initiativePrompt(split, { delivery, splitMuted: true }) ?? '';
    expect(muted).toContain(delivery);
    expect(muted).not.toContain(DELIVERY_AFTER_SPLIT);
    const off = { taskSplitInitiative: false, handoffInitiative: false };
    expect(initiativePrompt(off, { delivery })).not.toContain(DELIVERY_AFTER_SPLIT);
  });
});
