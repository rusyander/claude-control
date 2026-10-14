import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalModelsInfo, LocalServerInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { KeepAwake } from './KeepAwake';

/**
 * «Не давать системе уснуть во время прогона» (L4b): включено по умолчанию, пояснение
 * по состоянию выключателя, строка «сейчас держится» только пока запрет стоит.
 */

function render(server: Partial<LocalServerInfo>): string {
  const info = { server: { keepAwake: true, ...server } } as LocalModelsInfo;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <KeepAwake info={info} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('запрет сна на время прогона', () => {
  it('включён: переключатель нажат, подпись говорит, когда запрет стоит', () => {
    const html = render({});
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(i18n.t('localModels.keepAwake.on'));
    expect(html).not.toContain(i18n.t('localModels.keepAwake.holding'));
  });

  it('выключен: подпись предупреждает, что сон оборвёт прогон', () => {
    const html = render({ keepAwake: false });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(i18n.t('localModels.keepAwake.off'));
  });

  it('запрет стоит прямо сейчас — об этом сказано', () => {
    expect(render({ awake: true })).toContain(i18n.t('localModels.keepAwake.holding'));
  });
});
