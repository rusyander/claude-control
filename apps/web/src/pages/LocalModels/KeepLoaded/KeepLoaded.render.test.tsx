import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalModelsInfo, LocalServerInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { KeepLoaded } from './KeepLoaded';

/**
 * «Держать загруженной» на карточке сервера (L4): по умолчанию объясняет выгрузку по
 * простою и называет срок из ответа сервера, включённая — говорит, что память занята,
 * спящий сервер — что модель сейчас выгружена.
 */

function render(server: Partial<LocalServerInfo>): string {
  const info = {
    server: { keepLoaded: false, idleSeconds: 600, idleMinutes: 5, ...server },
  } as LocalModelsInfo;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <KeepLoaded info={info} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('держать модель загруженной', () => {
  it('по умолчанию выключено: срок простоя берётся из ответа сервера, в минутах', () => {
    const html = render({});
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(i18n.t('localModels.keepLoaded.off', { minutes: 10, withSave: 19 }));
    expect(render({ idleSeconds: 300 })).toContain(
      i18n.t('localModels.keepLoaded.off', { minutes: 5, withSave: 9 }),
    );
  });

  it('включено: переключатель нажат, подпись про занятую память вместо срока', () => {
    const html = render({ keepLoaded: true });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(i18n.t('localModels.keepLoaded.on'));
    expect(html).not.toContain(i18n.t('localModels.keepLoaded.off', { minutes: 10, withSave: 19 }));
  });

  it('срок выгрузки на выбор — только когда модель не держат; выбран срок из ответа сервера', () => {
    const html = render({ idleMinutes: 15 });
    expect(html).toContain(i18n.t('localModels.keepLoaded.idleLabel'));
    for (const minutes of [5, 15, 60]) {
      expect(html).toContain(i18n.t(`localModels.keepLoaded.idle${minutes}`));
    }
    expect(html).toMatch(/<option value="15" selected="">/);
    expect(render({ keepLoaded: true })).not.toContain(i18n.t('localModels.keepLoaded.idleLabel'));
  });

  it('сервер спит по простою — об этом сказано, у бодрствующего строки нет', () => {
    expect(render({ sleeping: true })).toContain(i18n.t('localModels.keepLoaded.sleeping'));
    expect(render({})).not.toContain(i18n.t('localModels.keepLoaded.sleeping'));
  });
});
