import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from './truncated-text';

/**
 * Текст, который обрезается по ширине, а полностью показывается подсказкой —
 * и только если он действительно не поместился.
 */
const meta = {
  title: 'Компоненты/TruncatedText',
  component: TruncatedText,
  parameters: {
    docs: {
      description: {
        component:
          'Обычный `title` у обрезанного текста вешают на всё подряд, и подсказка ' +
          'всплывает даже там, где текст виден целиком, — это раздражает. ' +
          'Здесь подсказка появляется только при реальном переполнении.\n\n' +
          'Нужен для того, что приходит извне и длину чего мы не выбираем: пути ' +
          'к файлам, названия чатов, описания скиллов, команды хуков.',
      },
    },
  },
  args: {
    text: 'C:\\Users\\rusyander\\AppData\\Local\\Temp\\claude\\c--work-claude-control\\scratchpad\\dirA',
    variant: 'mono',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['heading-sm', 'body', 'body-sm', 'caption', 'mono'],
    },
    color: { control: 'select', options: ['default', 'muted', 'subtle'] },
  },
  render: (args) => (
    <div style={{ width: 320, border: '1px dashed var(--color-border)', padding: 8 }}>
      <TruncatedText {...args} />
    </div>
  ),
} satisfies Meta<typeof TruncatedText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обрезанный: Story = {};

export const ПомещаетсяЦеликом: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Текст влезает — подсказки нет, наводить не на что.',
      },
    },
  },
  args: { text: 'settings.json' },
};

export const РазныеШирины: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Один и тот же путь в колонках разной ширины. Наведите курсор: ' +
          'подсказка появляется только там, где текст обрезан.',
      },
    },
  },
  render: (args) => (
    <Stack gap="var(--spacing-md)">
      {[520, 360, 220, 140].map((width) => (
        <Stack key={width} gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {width} px
          </Typography>
          <Card padding="sm" style={{ width }}>
            <TruncatedText {...args} />
          </Card>
        </Stack>
      ))}
    </Stack>
  ),
};

export const ВСтрокеСписка: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Как это работает в списке переменных окружения — рядом с именем и значением.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-xs)" style={{ maxWidth: 460 }}>
      {(
        [
          ['GITLAB_API_URL', 'https://git.gorgona.ai/api/v4'],
          [
            'CLAUDE_CONFIG_DIR',
            'C:\\Users\\rusyander\\AppData\\Roaming\\claude-control\\configuration\\profiles\\default',
          ],
          ['TELEGRAM_CHAT_ID', '-1004406877612'],
        ] as const
      ).map(([name, value]) => (
        <Card key={name} padding="sm">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium" as="span">
              {name}
            </Typography>
            <TruncatedText text={value} variant="mono" color="muted" />
          </Stack>
        </Card>
      ))}
    </Stack>
  ),
};
