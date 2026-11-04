import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexKitAppend } from './codex.ts';
import { CODEX_APPEND_MAX } from './service.ts';

/**
 * Настоящий набор, а не придуманный: правило локальной модели растёт (память задачи,
 * ночной прогон), и однажды оно вместе со стандартными правилами перестанет влезать в
 * дописку сеанса Codex через ядро. Тест краснеет раньше, чем это случится у человека.
 */
const KIT = fileURLToPath(new URL('../../../assets/kit/agentdeck-kit', import.meta.url));
/** Запас: набор растёт, отказ «не помещается» не должен прийти от одной новой строки. */
const HEADROOM = 2_000;

describe('набор Codex из поставляемых файлов', () => {
  for (const local of [false, true]) {
    it(`${local ? 'локальный' : 'обычный'} вариант влезает в дописку сеанса с запасом`, () => {
      // Без предела — полный вид (с описаниями навыков): ступени ужатия молча прятали бы рост.
      const text = codexKitAppend({ kitDir: KIT, local, max: Number.MAX_SAFE_INTEGER });
      console.log(
        `codex kit ${local ? 'local' : 'standard'}: ${text.length} of ${CODEX_APPEND_MAX}`,
      );
      expect(text.length).toBeLessThan(CODEX_APPEND_MAX - HEADROOM);
    });
  }

  it('локальный вариант несёт правило памяти задачи', () => {
    const text = codexKitAppend({ kitDir: KIT, local: true, max: CODEX_APPEND_MAX });
    expect(text).toContain('.agent/PROGRESS.md');
    expect(text).toContain('Task memory');
  });
});
