import { describe, expect, it } from 'vitest';
import { signalDef } from './catalog.ts';
import { judgeSignal } from './judge.ts';
import { routeMismatchVerdict } from './route-mismatch.ts';

const at = (modelAsked: string | null, modelServed: string) =>
  routeMismatchVerdict({ sessionId: 's1', routeId: 'api-key:endpoint:a', modelAsked, modelServed });

describe('P119 route-mismatch judge (observer)', () => {
  it('the same model, its dated snapshot or a gateway vendor prefix is not a mismatch; nothing asked → nothing to compare', () => {
    for (const [asked, served] of [
      ['stub-model', 'stub-model'],
      ['gpt-4o', 'gpt-4o-2024-08-06'],
      ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
      ['claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5'],
      ['Stub-Model', 'stub-model'],
    ] as const)
      expect(at(asked, served).fired, `${asked} → ${served}`).toBe(false);
    expect(at(null, 'whatever')).toMatchObject({ fired: false });
  });

  it('another model than asked fires a warn route-mismatch with action show, naming route, asked and served', () => {
    for (const [asked, served] of [
      ['stub-model', 'substituted-model'],
      ['gpt-4o', 'gpt-4o-mini'],
      ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
      ['gpt-4o', 'gpt-4o-x2024-08-06'],
    ] as const)
      expect(at(asked, served).fired, `${asked} → ${served}`).toBe(true);
    const verdict = at('stub-model', 'substituted-model');
    // Вердикт — факт без серьёзности; ключ повтора — сеанс (подмена пишется раз на сеанс).
    expect(verdict).toEqual({
      fired: true,
      signal: 'route-mismatch',
      subject: 's1',
      detail: 'route api-key:endpoint:a: asked stub-model, served substituted-model',
      reasons: [
        'model served substituted-model ≠ asked stub-model on the pinned route api-key:endpoint:a',
      ],
      key: 'route-mismatch:s1',
      sessionId: 's1',
    });
    // Серьёзность и действие — из каталога через единственного судью класса `observer`.
    expect(judgeSignal(verdict, signalDef('route-mismatch')!)).toEqual({
      fired: true,
      signal: 'route-mismatch',
      severity: 'warn',
      action: 'show',
      subject: 's1',
      detail: 'route api-key:endpoint:a: asked stub-model, served substituted-model',
      reasons: [
        'model served substituted-model ≠ asked stub-model on the pinned route api-key:endpoint:a',
        'catalog route-mismatch (first): warn → show',
      ],
      humanPoint: null,
    });
  });
});
