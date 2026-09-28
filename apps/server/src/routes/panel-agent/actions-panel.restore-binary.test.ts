import { describe, expect, it } from 'vitest';
import { PANEL_READ_ACTIONS } from './actions-panel.ts';
import type { InjectRoute } from './registry.ts';

/**
 * F-296. Строка о двоичном файле в диффе карточки отката была только русской и
 * без `diffEn`: английское окно показывало её по-русски. Маршруты подменены —
 * проверяется сама сборка карточки.
 */
describe('restore_backup: двоичный файл в карточке', () => {
  it('английское окно получает английскую строку о двоичном файле', async () => {
    const action = PANEL_READ_ACTIONS.find((item) => item.name === 'restore_backup')!;
    const inject: InjectRoute = async ({ url }) => {
      if (url === '/api/backups') {
        return {
          status: 200,
          body: {
            items: [
              {
                name: 'b1',
                target: 'skills/x',
                canRestore: true,
                encrypted: false,
                createdAt: '2026-09-27T10:00:00.000Z',
              },
            ],
          },
        };
      }
      if (url === '/api/backups/b1/preview') {
        return {
          status: 200,
          body: {
            files: [
              { path: 'skills/x/logo.png', diff: '', added: 0, removed: 0, binary: true },
              {
                path: 'skills/x/SKILL.md',
                diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-a\n+b\n',
                added: 1,
                removed: 1,
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    };
    const preview = await action.preview!({ name: 'b1' } as never, inject);
    expect(preview.diff).toContain('двоичный файл');
    expect(preview.diffEn).toContain('binary file');
    expect(preview.diffEn).not.toMatch(/[а-яё]/i);
    expect(preview.diffEn).toContain('+b');
  });
});
