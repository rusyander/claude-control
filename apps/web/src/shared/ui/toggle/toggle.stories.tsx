import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Toggle } from './toggle';

/**
 * Переключатель включения. Действует сразу, без кнопки «Сохранить» —
 * поэтому применяется там, где результат виден немедленно и обратим.
 */
const meta = {
  title: 'Формы/Toggle',
  component: Toggle,
  parameters: {
    docs: {
      description: {
        component:
          'Построен на Radix: клавиатура, роли и состояния уже сделаны правильно, ' +
          'на нашей стороне только стили.\n\n' +
          '`aria-label` — обязательный проп. Переключатель без подписи ' +
          'для скринридера безымянный, а рядом стоящий текст сам по себе с ним ' +
          'не связывается.',
      },
    },
  },
  args: { checked: true, 'aria-label': 'Включить скилл', onCheckedChange: () => undefined },
  argTypes: {
    size: { control: 'select', options: ['sm', 'md'] },
    disabled: { control: 'boolean' },
    checked: { control: 'boolean' },
  },
  render: function Render(args) {
    const [checked, setChecked] = useState(args.checked);
    return <Toggle {...args} checked={checked} onCheckedChange={setChecked} />;
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const Состояния: Story = {
  render: () => (
    <Stack direction="row" gap="var(--spacing-lg)" align="center" wrap>
      {(
        [
          [true, false, 'включён'],
          [false, false, 'выключен'],
          [true, true, 'включён, недоступен'],
          [false, true, 'выключен, недоступен'],
        ] as const
      ).map(([checked, disabled, label]) => (
        <Stack key={label} align="center" gap="var(--spacing-2xs)">
          <Toggle
            checked={checked}
            disabled={disabled}
            onCheckedChange={() => undefined}
            aria-label={label}
          />
          <Typography variant="caption" color="subtle" as="span">
            {label}
          </Typography>
        </Stack>
      ))}
    </Stack>
  ),
};

export const Размеры: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '`md` — в строках списков, `sm` — внутри плотных мест: шапка чата, ' +
          'панели инструментов.',
      },
    },
  },
  render: function Render() {
    const [small, setSmall] = useState(true);
    const [medium, setMedium] = useState(true);

    return (
      <Stack direction="row" gap="var(--spacing-lg)" align="center">
        <Stack align="center" gap="var(--spacing-2xs)">
          <Toggle size="sm" checked={small} onCheckedChange={setSmall} aria-label="Мелкий" />
          <Typography variant="caption" color="subtle" as="span">
            sm
          </Typography>
        </Stack>
        <Stack align="center" gap="var(--spacing-2xs)">
          <Toggle size="md" checked={medium} onCheckedChange={setMedium} aria-label="Обычный" />
          <Typography variant="caption" color="subtle" as="span">
            md
          </Typography>
        </Stack>
      </Stack>
    );
  },
};

export const СПодписью: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Строка настройки: название, пояснение и переключатель. Ширина строки ' +
          'ограничена намеренно — на широком экране переключатель уезжал бы ' +
          'от своей подписи через полэкрана пустоты.',
      },
    },
  },
  render: function Render() {
    const [settings, setSettings] = useState({ large: false, motion: true, contrast: false });

    const rows = [
      ['large', 'Крупный текст', 'Увеличивает всю шкалу шрифтов'],
      ['motion', 'Меньше движения', 'Отключает анимации и переходы'],
      ['contrast', 'Высокий контраст', 'Усиливает границы и цвет текста'],
    ] as const;

    return (
      <Card padding="md" style={{ maxWidth: 'var(--text-measure)' }}>
        <Stack gap="var(--spacing-md)">
          {rows.map(([key, label, hint]) => (
            <Stack
              key={key}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-md)"
            >
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" as="span">
                  {label}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {hint}
                </Typography>
              </Stack>
              <Toggle
                checked={settings[key]}
                onCheckedChange={(value) => setSettings((c) => ({ ...c, [key]: value }))}
                aria-label={label}
              />
            </Stack>
          ))}
        </Stack>
      </Card>
    );
  },
};
