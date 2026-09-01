import { describe, it, expect } from 'vitest';
import { initiativePrompt } from './initiative.ts';

/**
 * Инициативы уезжают к агенту одним аргументом командной строки, поэтому
 * проверяем не текст, а два его свойства: складываются ли включённые тумблеры и
 * остаётся ли результат ОДНОЙ строкой. Перевод строки внутри аргумента cmd.exe
 * молча обрезает команду — эту цену уже платили.
 */
describe('строка инициатив для прогона', () => {
  it('оба тумблера выключены — дописывать нечего', () => {
    expect(
      initiativePrompt({ taskSplitInitiative: false, handoffInitiative: false }),
    ).toBeUndefined();
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
});
