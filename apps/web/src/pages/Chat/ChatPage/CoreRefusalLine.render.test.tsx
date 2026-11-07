import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { coreRefusalOf } from './coreRefusal';
import { CoreRefusalLine } from './CoreRefusalLine';

/**
 * Отказ ядра запуску CLI в ленте `/chat` (W3-17a). Путь настоящий: ошибка хода в том виде, в каком
 * её отдаёт сервер (`refusal-text.ts`: код `core-chat-refused` с `code`, коды переноса слоя), идёт
 * через `coreRefusalOf` и рисуется `CoreRefusalLine` со словарём панели. Ошибка, которую человек
 * чинит в этом же чате (модель вне маршрута), и любая иная — не отказ: композер остаётся.
 */

const refused = (code: string, extra: Record<string, string> = {}) => ({
  error: 'refused',
  errorCode: 'core-chat-refused',
  errorParams: { code, ...extra },
});

const html = (stream: Parameters<typeof coreRefusalOf>[0]): string => {
  const refusal = coreRefusalOf(stream);
  return refusal ? renderToStaticMarkup(<CoreRefusalLine refusal={refusal} />) : '';
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('core launch refusal line in the /chat feed', () => {
  it('no_core_hook — named line with the code, role=alert', () => {
    const out = html(refused('no_core_hook'));
    expect(out).toContain('data-core-chat-launch-refused="no_core_hook"');
    expect(out).toContain('role="alert"');
    expect(out).toContain('у него нет хука ядра');
    expect(out).toContain('(no_core_hook)');
  });

  it('adapter_not_built — its own line; another compat code — the general line with code and setting', () => {
    expect(html(refused('adapter_not_built'))).toContain(
      'data-core-chat-launch-refused="adapter_not_built"',
    );
    const other = html(refused('bypass_setting', { setting: 'dangerously-skip' }));
    expect(other).toContain('data-core-chat-launch-refused="other"');
    expect(other).toContain('Ядро отказало запуску CLI: bypass_setting dangerously-skip');
  });

  it('a layer-carry refusal code maps to its line with its params', () => {
    const out = html({
      error: 'x',
      errorCode: 'core-chat-carry-unsupported',
      errorParams: { adapter: 'qwen', fields: 'kit' },
    });
    expect(out).toContain('data-core-chat-launch-refused="carryUnsupported"');
    expect(out).toContain('CLI qwen не умеет');
  });

  it('model_absent, an unknown code, an unrelated error or no error — no refusal (composer stays)', () => {
    expect(coreRefusalOf(refused('model_absent'))).toBeNull();
    expect(coreRefusalOf(refused('made_up'))).toBeNull();
    expect(coreRefusalOf({ error: 'boom', errorCode: 'chat-run-failed' })).toBeNull();
    expect(
      coreRefusalOf({ errorCode: 'core-chat-refused', errorParams: { code: 'no_core_hook' } }),
    ).toBeNull();
    expect(coreRefusalOf({})).toBeNull();
  });
});
