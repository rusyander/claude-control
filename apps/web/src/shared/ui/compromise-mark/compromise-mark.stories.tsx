import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CompromiseMark } from './compromise-mark';

/**
 * Знак компромисса: подпись рядом с тем, что она объясняет.
 *
 * Витрина показывает три уровня и крайний случай — флажок у правого края, где
 * подсказка обязана развернуться внутрь экрана, а не за него.
 */
const meta = {
  title: 'Компоненты/CompromiseMark',
  component: CompromiseMark,
  parameters: {
    docs: {
      description: {
        component:
          'Панель ходит в чужую платформу, и часть её свойств обойти нельзя — можно только ' +
          'назвать вслух. Значок стоит вплотную к тому, что объясняет, открывается по наведению ' +
          'И по фокусу, закрывается Escape с возвратом фокуса на кнопку.\n\n' +
          'Не `title=`: атрибут не открывается с клавиатуры, не форматируется и молчит на телефоне.',
      },
    },
  },
  args: { id: 'no-client-tools' },
} satisfies Meta<typeof CompromiseMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ограничение: Story = {};

export const Обход: Story = { args: { id: 'budget-manual' } };

export const СРиском: Story = { args: { id: 'gateway-required' } };

export const ВСтрокеМатрицы: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Как знак стоит в матрице возможностей — рядом со словом, а не в конце строки.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-sm)" style={{ maxWidth: 420 }}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Typography variant="body-sm">Знания компании</Typography>
        <Typography variant="body-sm" color="muted">
          косвенно
        </Typography>
        <CompromiseMark id="kb-via-owner" />
      </Stack>
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Typography variant="body-sm">Инструменты свои</Typography>
        <Typography variant="body-sm" color="muted">
          нет
        </Typography>
        <CompromiseMark id="no-client-tools" />
      </Stack>
    </Stack>
  ),
};

export const УПравогоКрая: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Флажок прижат к правому краю: подсказка разворачивается влево. Замер делается перед ' +
          'показом, поэтому текст не уезжает за экран ни в одной теме.',
      },
    },
  },
  render: () => (
    <Stack direction="row" justify="end" style={{ width: '100%' }}>
      <CompromiseMark id="probe-guess" />
    </Stack>
  ),
};
