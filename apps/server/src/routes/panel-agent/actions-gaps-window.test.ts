import { describe, expect, it } from 'vitest';
import { maskSecretsInText } from '../../lib/secret-mask/secret-mask.ts';
import { textWindow } from './action-kit/action-kit.ts';
import type { AnyPanelAction } from './registry.ts';
import { GAPS_PROJECT_ACTIONS } from './actions-gaps-projects/actions-gaps-projects.ts';
import { GAPS_TESTS_ACTIONS } from './actions-gaps-tests/actions-gaps-tests.ts';

/**
 * Маска до окна (ревью сит, 28.09): `draft_defect` резал тело окном и только
 * потом маскировал, `read_project_local_config` — обрезал начало правила. Ключ на
 * краю окна уходил по кускам: половина — короче порога маски — проходила как
 * обычный текст. Здесь настоящий `shape` действий над телом, где ключ стоит на
 * самой границе.
 */

const KEY = ['q8ZrLk2Wm9Xa7', 'Tb4Nc1PdVe6Hf3', 'Jg0Rs5Yu2Kp9L'].join('');
const HEAD = KEY.slice(0, 16);
const TAIL = KEY.slice(-16);

function action(list: readonly AnyPanelAction[], name: string): AnyPanelAction {
  const found = list.find((item) => item.name === name);
  if (!found?.shape) throw new Error(`no ${name}`);
  return found;
}

describe('маска до окна', () => {
  it('draft_defect: ключ на краю окна не уходит ни в одном окне', () => {
    const draftDefect = action(GAPS_TESTS_ACTIONS, 'draft_defect');
    // Окно — до 15 000 знаков JSON; ключ ставим так, чтобы край прошёл по его середине.
    const first = draftDefect.shape!({ offset: 0 } as never, {
      draft: { title: 't', body: 'a'.repeat(40_000), targets: [] },
    }) as { body: { text: string } };
    const edge = first.body.text.length;
    const body = `${'a '.repeat(Math.floor((edge - 20) / 2))} ${KEY} tail ${'b '.repeat(9000)}`;
    const draft = { draft: { title: 't', body, targets: [] } };
    // Предусловие: край окна режет ключ, и прежний порядок (окно, потом маска)
    // оставлял его половину на виду — иначе тест не мог бы покраснеть.
    const oldOrder = maskSecretsInText(textWindow(body, 0).text);
    expect(oldOrder).toContain(HEAD);
    expect(oldOrder).not.toContain(KEY);

    const windowA = draftDefect.shape!({ offset: 0 } as never, draft) as {
      body: { text: string; nextOffset?: number };
    };
    const windowB = draftDefect.shape!({ offset: windowA.body.nextOffset ?? edge } as never, draft);
    const seen = JSON.stringify([windowA, windowB]);
    expect(seen).not.toContain(HEAD);
    expect(seen).not.toContain(TAIL);
  });

  it('read_project_local_config: ключ на границе превью правила не уходит половиной', () => {
    const readLocal = action(GAPS_PROJECT_ACTIONS, 'read_project_local_config');
    const body = `${'x '.repeat(142)}${KEY} rest of the rule`;
    expect(maskSecretsInText(body.slice(0, 300))).toContain(HEAD);
    const out = JSON.stringify(
      readLocal.shape!({} as never, {
        root: '/p',
        exists: true,
        skills: [],
        hooks: [],
        rules: [{ path: 'r.md', title: 'r', paths: [], sizeBytes: body.length, body }],
      }),
    );
    expect(out).not.toContain(HEAD);
  });
});
