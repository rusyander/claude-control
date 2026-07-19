import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SearchField } from './search-field';

/** Поиск по списку. Фильтрует на лету — кнопки «Найти» нет намеренно. */
const meta = {
  title: 'Формы/SearchField',
  component: SearchField,
  parameters: {
    docs: {
      description: {
        component:
          'Список фильтруется по мере набора: искать по локальным данным мгновенно, ' +
          'и отдельное действие «найти» только мешало бы.\n\n' +
          'Подпись обязательна, но визуально скрыта — значок лупы понятен глазом, ' +
          'а скринридеру нужно название.',
      },
    },
  },
  args: {
    label: 'Поиск по чатам',
    value: '',
    onChange: () => undefined,
    placeholder: 'название, проект или текст',
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <SearchField {...args} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof SearchField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычное: Story = {};

export const СоСчётчиком: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Рядом с поиском полезно показывать, сколько нашлось из скольких: ' +
          'пустой результат тогда объясняет сам себя.',
      },
    },
  },
  render: function Render() {
    const items = [
      'a11y-audit',
      'api-contract-sync',
      'bug-regression-test',
      'changelog-builder',
      'db-migration-safety',
      'dependency-risk-review',
    ];
    const [query, setQuery] = useState('a');
    const found = items.filter((item) => item.includes(query.trim().toLowerCase()));

    return (
      <Stack gap="var(--spacing-xs)" style={{ width: 320 }}>
        <SearchField label="Поиск по скиллам" value={query} onChange={setQuery} placeholder="имя" />
        <Typography variant="caption" color="subtle">
          Показано {found.length} из {items.length}
        </Typography>
        <Stack gap="var(--spacing-3xs)">
          {found.map((item) => (
            <Typography key={item} variant="body-sm" as="span">
              {item}
            </Typography>
          ))}
          {found.length === 0 && (
            <Typography variant="body-sm" color="subtle">
              Ничего не найдено
            </Typography>
          )}
        </Stack>
      </Stack>
    );
  },
};
