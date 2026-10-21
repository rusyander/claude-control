import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { appSettingsSchema } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { GroupEconomyCard } from './GroupEconomyCard';

/**
 * Переменная `AGENTDECK_GROUP_COMPACT_WINDOW` сильнее рычага порога (F-19 ревью П1):
 * карточка называет её, иначе показывала бы порог, с которым группы не идут. И
 * «5 минут» кэша помечены как нерекомендуемые (F-24): пауза пишет окно заново.
 */

const render = (system: { groupCompactWindowEnv: number | null }): string => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.system, system);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GroupEconomyCard settings={appSettingsSchema.parse({})} patch={() => undefined} />
    </QueryClientProvider>,
  );
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка экономии групп', () => {
  it('переменная панели задаёт порог — карточка называет её и число', () => {
    const html = render({ groupCompactWindowEnv: 160_000 });
    expect(html).toContain('AGENTDECK_GROUP_COMPACT_WINDOW: выбор выше не действует');
    expect(html).toContain('порогом 160 тысяч');
  });

  it('переменной нет — строки о ней нет', () => {
    expect(render({ groupCompactWindowEnv: null })).not.toContain('выбор выше не действует');
  });

  it('«5 минут» срока кэша помечены как нерекомендуемые', () => {
    expect(render({ groupCompactWindowEnv: null })).toContain(
      '5 минут (не рекомендуется: пауза пишет окно заново)',
    );
  });
});
