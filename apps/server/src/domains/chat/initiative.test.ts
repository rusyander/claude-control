import { describe, it, expect } from 'vitest';
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
  it('оба тумблера выключены — остаётся правило про вопрос человеку', () => {
    const bare = initiativePrompt({ taskSplitInitiative: false, handoffInitiative: false }) ?? '';

    expect(bare).toContain('AskUserQuestion');
    expect(bare).toContain('Answer questions?');
    expect(bare).toContain('отказ панели');
    expect(bare).not.toContain('claude-control:split');
    expect(bare).not.toContain('claude-control:handoff');
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
    expect(both).toContain('claude-control:split');
    expect(both).toContain('claude-control:handoff');
  });

  it('каждый тумблер отвечает только за свою инициативу', () => {
    const split = initiativePrompt({ taskSplitInitiative: true, handoffInitiative: false });
    expect(split).toContain('claude-control:split');
    expect(split).not.toContain('claude-control:handoff');

    const handoff = initiativePrompt({ taskSplitInitiative: false, handoffInitiative: true });
    expect(handoff).toContain('claude-control:handoff');
    expect(handoff).not.toContain('claude-control:split');
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
      expect(prompt.startsWith('Этот прогон запущен из панели Claude Control')).toBe(true);
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

    expect(muted).not.toContain('claude-control:split');
    expect(muted).toContain('claude-control:handoff');
    expect(muted.startsWith('Этот прогон запущен из панели Claude Control')).toBe(true);
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
    expect(split).toContain('ОДНА задача');
    expect(split).toContain('не больше одного раза за разговор');
  });
});
