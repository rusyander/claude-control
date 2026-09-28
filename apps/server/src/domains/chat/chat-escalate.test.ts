import { describe, it, expect } from 'vitest';
import {
  ESCALATE_LANG,
  parseEscalateBody,
  scanEscalateBlocks,
  withoutEscalateBlocks,
} from '@agentdeck/contracts/chat-escalate';
import { ESCALATE_BLOCK_LANG, escalationSchema } from '@agentdeck/contracts/chat-group-settings';

/**
 * Блок критического замечания (контракт без zod — его берут и сервер, и лента,
 * и телефон). Три случая, как у блока продолжения: разобранный уходит из текста,
 * сломанный остаётся, незакрытый прячется только в потоке. И разбор без zod
 * обязан соглашаться со схемой — иначе телефон и сервер разойдутся.
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

  it('разбор без zod согласен со схемой', () => {
    expect(ESCALATE_LANG).toBe(ESCALATE_BLOCK_LANG);
    const bodies = [
      { severity: 'critical', text: 'да' },
      { severity: 'critical', text: '' },
      { severity: 'minor', text: 'нет' },
      { severity: 'critical', text: 'x'.repeat(2_001) },
      { severity: 'critical' },
    ];
    for (const body of bodies) {
      expect(Boolean(parseEscalateBody(JSON.stringify(body)))).toBe(
        escalationSchema.safeParse(body).success,
      );
    }
    expect(parseEscalateBody('не json')).toBeUndefined();
    expect(parseEscalateBody('[1]')).toBeUndefined();
  });
});
