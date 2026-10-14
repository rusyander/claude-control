import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODEX_KIT_ARG_LIMIT, buildCodexOverlay } from './codex.ts';

/**
 * Настоящий набор, а не придуманный: правило локальной модели растёт (память задачи,
 * ночной прогон), и однажды оно вместе со стандартными правилами перестанет влезать в
 * командную строку Codex. Тест краснеет раньше, чем это случится у человека.
 */
const KIT = fileURLToPath(new URL('../../../assets/kit/agentdeck-kit', import.meta.url));
/** Запас на промпт, модель и путь рядом с инструкциями в той же командной строке. */
const HEADROOM = 2_000;

describe('набор Codex из поставляемых файлов', () => {
  for (const local of [false, true]) {
    it(`${local ? 'локальный' : 'обычный'} вариант влезает в предел с запасом`, () => {
      const overlay = buildCodexOverlay({
        kitDir: KIT,
        local,
        codexHome: fileURLToPath(new URL('./no-such-codex-home', import.meta.url)),
      });
      // Как в `buildCodexOverlay`: предел считается по JSON-строке аргумента, а не по сырому тексту.
      const arg = (text: string) => `developer_instructions=${JSON.stringify(text)}`.length;
      const longest = Math.max(arg(overlay.appServer), arg(overlay.exec));
      console.log(
        `codex kit ${local ? 'local' : 'standard'}: ${longest} of ${CODEX_KIT_ARG_LIMIT}`,
      );
      expect(longest).toBeLessThan(CODEX_KIT_ARG_LIMIT - HEADROOM);
    });
  }

  it('локальный вариант несёт правило памяти задачи', () => {
    const overlay = buildCodexOverlay({
      kitDir: KIT,
      local: true,
      codexHome: fileURLToPath(new URL('./no-such-codex-home', import.meta.url)),
    });
    expect(overlay.exec).toContain('.agent/PROGRESS.md');
    expect(overlay.exec).toContain('Task memory');
  });
});
