import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SearchField } from '@shared/ui/search-field';
import { Toggle } from '@shared/ui/toggle';
import { BarChart } from '@shared/ui/bar-chart';
import { TimeSeries } from '@shared/ui/time-series';
import { SkeletonList, SkeletonTiles, SkeletonChart } from '@shared/ui/skeleton';

/**
 * Собранные экраны: как элементы работают вместе.
 *
 * Отдельный компонент почти всегда выглядит хорошо. Разъезжается всё на стыках —
 * когда рядом встают карточка со значком, кнопка и подпись. Поэтому здесь
 * показаны целые куски интерфейса, а не элементы по одному.
 */
const meta = {
  title: 'Композиции/Экраны',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Элементы в сборе — так, как они стоят на настоящих страницах. ' +
          'Проверять единообразие имеет смысл именно здесь: отдельная карточка ' +
          'всегда выглядит хорошо, а разъезжаются они на стыках.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const points = Array.from({ length: 30 }, (_, index) => {
  const shape = [3, 1, 4, 2, 6, 3, 2, 3, 9, 4, 2, 5, 3, 7, 4, 8, 5, 3, 6, 4];
  const value = (shape[index % shape.length] ?? 3) * 120_000_000;
  const date = new Date(2026, 5, 20 + index);

  return {
    label: `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    value,
    valueLabel: `${(value / 1_000_000_000).toFixed(1)} млрд`,
  };
});

export const СписокСущностей: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Каркас, повторяющийся на страницах правил, скиллов, хуков и плагинов: ' +
          'шапка с главным действием, свёрнутая справка, поиск, строки со значками ' +
          'и действиями справа. Все карточки здесь одного отступа — `md`.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-lg)" style={{ padding: 'var(--spacing-xl)', maxWidth: 1180 }}>
      <PageHeader
        title="Скиллы"
        subtitle="Наборы инструкций, которые Claude подключает по описанию"
        actions={<Button leftIcon={<Icon name="plus" size={24} />}>Создать скилл</Button>}
      />

      <ExplainBox
        title="Как это работает"
        text="Скилл — папка с файлом SKILL.md. Поле description решает, когда Claude его применит, поэтому оно должно точно описывать ситуацию."
      />

      <div style={{ maxWidth: 420 }}>
        <SearchField
          label="Поиск по скиллам"
          value=""
          onChange={() => undefined}
          placeholder="имя или описание"
        />
      </div>

      <Stack gap="var(--spacing-xs)">
        {[
          ['a11y-audit', '3.1 KB', 'Аудит доступности: axe-core, клавиатура, контраст', true],
          ['api-contract-sync', '3.4 KB', 'Сверка контрактов фронта и бэка по OpenAPI', true],
          [
            'db-migration-safety',
            '4.0 KB',
            'Безопасные миграции: обратимость и zero-downtime',
            false,
          ],
        ].map(([name, size, description, enabled]) => (
          <Card key={String(name)} padding="md">
            <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)" wrap>
              <Stack gap="var(--spacing-2xs)">
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium" as="span">
                    {String(name)}
                  </Typography>
                  <Typography variant="caption" color="subtle" as="span">
                    {String(size)}
                  </Typography>
                  {!enabled && <Badge tone="neutral">выключен</Badge>}
                </Stack>
                <Typography variant="body-sm" color="muted">
                  {String(description)}
                </Typography>
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                <Button
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="sandbox" size={20} />}
                  aria-label="Песочница"
                />
                <Button
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="edit" size={20} />}
                  aria-label="Изменить"
                />
                <Button
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size={20} />}
                  aria-label="Удалить"
                />
                <Toggle
                  checked={Boolean(enabled)}
                  onCheckedChange={() => undefined}
                  aria-label="Включить"
                />
              </Stack>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Stack>
  ),
};

export const ЭкранСМетриками: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Аналитика: плитки со значениями, график по дням и разбивка полосами. ' +
          'Плитки одной высоты — иначе ряд выглядит рваным.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-lg)" style={{ padding: 'var(--spacing-xl)', maxWidth: 1180 }}>
      <PageHeader
        title="Аналитика"
        subtitle="Расход токенов, сессии и работающие агенты — по локальным транскриптам"
        actions={
          <Stack direction="row" gap="var(--spacing-2xs)">
            <Button size="sm" variant="secondary">
              7 дней
            </Button>
            <Button size="sm">30 дней</Button>
            <Button size="sm" variant="secondary">
              90 дней
            </Button>
          </Stack>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 'var(--spacing-md)',
        }}
      >
        {[
          ['Всего токенов', '22,2 млрд', '22 239 847 620'],
          ['Запросов к модели', '54 153', '3 активных сессии'],
          ['Сгенерировано', '88,9 млн', '88 938 806'],
          ['Прочитано из кэша', '96,6 %', '21,4 млрд'],
        ].map(([label, value, hint]) => (
          <Card key={label} padding="md">
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" color="muted" as="span">
                {label}
              </Typography>
              <Typography variant="heading">{value}</Typography>
              <Typography variant="caption" color="subtle" as="span">
                {hint}
              </Typography>
            </Stack>
          </Card>
        ))}
      </div>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body" weight="medium">
              Расход по дням
            </Typography>
            <Typography variant="caption" color="subtle">
              Все токены: вход, выход и работа с кэшем
            </Typography>
          </Stack>
          <TimeSeries points={points} seriesName="Все токены" />
        </Stack>
      </Card>

      <Card padding="md" style={{ maxWidth: 560 }}>
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            По моделям
          </Typography>
          <BarChart
            items={[
              { id: '1', label: 'claude-opus-4-8', value: 18_700_000_000, valueLabel: '18,7 млрд' },
              { id: '2', label: 'claude-fable-5', value: 3_500_000_000, valueLabel: '3,5 млрд' },
              { id: '3', label: 'claude-opus-4-7', value: 14_300_000, valueLabel: '14,3 млн' },
            ]}
          />
        </Stack>
      </Card>
    </Stack>
  ),
};

export const СостоянияЗагрузки: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Как страницы выглядят, пока данные читаются. Форма заглушки повторяет ' +
          'форму содержимого — иначе при появлении данных раскладка прыгнет.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-xl)" style={{ padding: 'var(--spacing-xl)', maxWidth: 1180 }}>
      <Stack gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle" as="span">
          обзор
        </Typography>
        <SkeletonTiles count={4} />
      </Stack>

      <Stack gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle" as="span">
          аналитика
        </Typography>
        <SkeletonChart />
      </Stack>

      <Stack gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle" as="span">
          список сущностей
        </Typography>
        <SkeletonList rows={4} />
      </Stack>
    </Stack>
  ),
};

export const ПустыеСостояния: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Три разные пустоты. Текст у каждой свой: «ещё не создано» — с действием, ' +
          '«не нашлось» — без него, «данных нет по существу» — с объяснением почему.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-2xl)" style={{ padding: 'var(--spacing-xl)' }}>
      <Card padding="lg">
        <EmptyState
          icon="groups"
          title="Пока нет ни одной группы"
          text="Группа объединяет правила, скиллы, хуки и серверы, чтобы включать их разом."
          action={<Button leftIcon={<Icon name="plus" size={24} />}>Создать группу</Button>}
        />
      </Card>

      <Card padding="lg">
        <EmptyState icon="search" title="Ничего не найдено" text="Попробуйте другое слово." />
      </Card>

      <Card padding="lg">
        <EmptyState
          icon="analytics"
          title="Данных за период нет"
          text="За выбранный отрезок обращений к модели не было."
        />
      </Card>
    </Stack>
  ),
};
