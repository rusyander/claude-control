import { describe, it, expect } from 'vitest';
import {
  ESCALATE_LANG,
  ESCALATE_TEXT_MAX,
  parseEscalateBody,
  scanEscalateBlocks,
  withoutEscalateBlocks,
} from '@agentdeck/contracts/chat-escalate';

/**
 * Блок критического замечания (контракт без zod — его берут и сервер, и лента,
 * и телефон). Три случая, как у блока продолжения: разобранный уходит из текста,
 * сломанный остаётся, незакрытый прячется только в потоке. Карточек замечаний
 * панель больше не ведёт — блок только прячется из текста, разбор остаётся.
 */
const fenced = (body: string): string => `\`\`\`${ESCALATE_LANG}\n${body}\n\`\`\``;

describe('блок agentdeck:escalate', () => {
  it('разобранный блок уходит из текста, замечание — в список', () => {
    const scan = scanEscalateBlocks(
      `До.\n\n${fenced('{"severity":"critical","text":" утечка ключа "}')}\n\nПосле.`,
    );
    expect(scan.blocks).toEqual([{ severity: 'critical', text: 'утечка ключа' }]);
    expect(scan.text).toBe('До.\n\nПосле.');
    expect(scan.rejected).toBe(0);
  });

  it('сломанный блок остаётся в тексте как есть', () => {
    const source = `Текст\n${fenced('{"severity":"minor","text":"x"}')}`;
    const scan = scanEscalateBlocks(source);
    expect(scan.blocks).toEqual([]);
    expect(scan.rejected).toBe(1);
    expect(scan.text).toContain('"minor"');
  });

  it('незакрытый: в потоке прячется, в законченном ответе остаётся', () => {
    const source = `Пишу\n\`\`\`${ESCALATE_LANG}\n{"severity":"crit`;
    expect(withoutEscalateBlocks(source, { streaming: true })).toBe('Пишу');
    expect(withoutEscalateBlocks(source)).toBe(source);
  });

  it('текст без блока не трогается вовсе', () => {
    expect(withoutEscalateBlocks('  как есть  \n')).toBe('  как есть  \n');
  });

  it('тело блока: только critical с непустым текстом до потолка', () => {
    expect(ESCALATE_LANG).toBe('agentdeck:escalate');
    const bodies: [unknown, boolean][] = [
      [{ severity: 'critical', text: 'да' }, true],
      [{ severity: 'critical', text: '' }, false],
      [{ severity: 'minor', text: 'нет' }, false],
      [{ severity: 'critical', text: 'x'.repeat(2_001) }, true],
      [{ severity: 'critical', text: 'x'.repeat(ESCALATE_TEXT_MAX + 1) }, false],
      [{ severity: 'critical' }, false],
    ];
    for (const [body, valid] of bodies) {
      expect(
        Boolean(parseEscalateBody(JSON.stringify(body))),
        JSON.stringify(body).slice(0, 60),
      ).toBe(valid);
    }
    expect(parseEscalateBody('не json')).toBeUndefined();
    expect(parseEscalateBody('[1]')).toBeUndefined();
  });
});
