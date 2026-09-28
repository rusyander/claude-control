import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Typography } from '@shared/ui/typography';
import { PageTabs, PageTabPanel } from './page-tabs';

/**
 * Вкладки страницы раздела: длинная страница, разложенная по заботам. Адрес и
 * память вкладки держит `usePageTab`, здесь — только полоса и панель.
 */
const meta = {
  title: 'Компоненты/PageTabs',
  component: PageTabs,
  parameters: {
    docs: {
      description: {
        component:
          'Настоящий `tablist`: Tab заводит в полосу одной остановкой, стрелки, Home и End ' +
          'ходят по вкладкам и сразу их открывают. Число справа — сколько записей на ' +
          'вкладке; пометка вместо числа (`note`) — то, что нельзя пропустить с соседней ' +
          'вкладки, например несохранённые правки.',
      },
    },
  },
  args: {
    page: 'story',
    label: 'Разделы',
    active: 'rules',
    onSelect: () => undefined,
    tabs: [],
  },
} satisfies Meta<typeof PageTabs>;

export default meta;

type Story = StoryObj<typeof meta>;

const TABS = [
  { id: 'proxy', label: 'Прокси', icon: 'lock' },
  { id: 'rules', label: 'Правила', icon: 'rules', count: 12 },
  { id: 'check', label: 'Проверка', icon: 'eye' },
  { id: 'journal', label: 'Журнал', icon: 'history', note: 'не сохранено' },
] as const;

/** Полоса с числом и пометкой; клик и стрелки переключают панель. */
export const Default: Story = {
  render: function Render() {
    const [active, setActive] = useState<(typeof TABS)[number]['id']>('rules');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PageTabs page="story" label="Разделы" tabs={TABS} active={active} onSelect={setActive} />
        <PageTabPanel page="story" tab={active} hint="Что лежит на этой вкладке — одной строкой.">
          <Typography>Содержимое вкладки «{active}».</Typography>
        </PageTabPanel>
      </div>
    );
  },
};
