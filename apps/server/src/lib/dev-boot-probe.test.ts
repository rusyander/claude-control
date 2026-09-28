import { describe, it, expect } from 'vitest';
import { importSpecifiers } from './dev-boot-probe.mjs';

/**
 * Ревью 28.09 (F-198): ленивое `[\s\S]*?\sfrom` перешагивало через конец
 * инструкции — импорт ради побочного эффекта, за которым шёл обычный,
 * проглатывался, и проба его не грузила.
 */
describe('importSpecifiers', () => {
  it('импорт ради побочного эффекта перед обычным не теряется', () => {
    expect(importSpecifiers("import './a.ts';\nimport x from './b.ts';\n")).toEqual([
      './a.ts',
      './b.ts',
    ]);
  });

  it('многострочный импорт и `import type`', () => {
    const source = "import {\n  a,\n  b,\n} from './c.ts';\nimport type { T } from './t.ts';\n";
    expect(importSpecifiers(source)).toEqual(['./c.ts']);
  });
});
