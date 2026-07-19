import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Modal } from './modal';

/**
 * Модальное окно. Одинаковое по всему приложению: рамка, шапка, нижняя
 * панель и появление приходят отсюда, размер выбирается из четырёх значений.
 */
const meta = {
  title: 'Компоненты/Modal',
  component: Modal,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Стоит на Radix: фокус-ловушка, закрытие по Escape, блокировка прокрутки ' +
          'фона и aria-роли уже сделаны.\n\n' +
          'Размер — из набора, а не числом на месте: `sm` — подтверждения, ' +
          '`md` — короткие формы, `lg` — формы подлиннее, `xl` — формы с помощником, ' +
          'где поля и чат стоят в две колонки. Все девять форм приложения — `xl`.\n\n' +
          'Появление и закрытие ведёт motion. Закрытие именно доигрывается: ' +
          'без этого окно исчезало бы мгновенно, а затемнение моргало.',
      },
    },
  },
  args: {
    isOpen: true,
    onOpenChange: () => undefined,
    title: 'Добавить правило',
    children: null,
  },
  argTypes: {
    size: { control: 'select', options: ['sm', 'md', 'lg', 'xl'] },
  },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Окно, которое можно закрыть и открыть заново — видно анимацию входа и выхода. */
export const Обычное: Story = {
  render: function Render(args) {
    const [isOpen, setIsOpen] = useState(false);
    const [value, setValue] = useState('');

    return (
      <>
        <Button onClick={() => setIsOpen(true)}>Открыть окно</Button>

        <Modal
          {...args}
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          description="Правило попадёт в CLAUDE.md и будет действовать во всех проектах"
          footer={
            <>
              <Button variant="secondary" onClick={() => setIsOpen(false)}>
                Отмена
              </Button>
              <Button onClick={() => setIsOpen(false)}>Сохранить</Button>
            </>
          }
        >
          <Stack gap="var(--spacing-md)">
            <TextField label="Заголовок" value={value} onChange={setValue} />
            <TextField
              label="Текст правила"
              value=""
              onChange={() => undefined}
              multiline
              rows={5}
            />
          </Stack>
        </Modal>
      </>
    );
  },
};

export const Размеры: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Каждая кнопка открывает окно своего размера — так видна разница.',
      },
    },
  },
  render: function Render() {
    const [size, setSize] = useState<'sm' | 'md' | 'lg' | 'xl' | undefined>(undefined);

    const purpose = {
      sm: 'Подтверждения и короткие сообщения',
      md: 'Короткие формы в два-три поля',
      lg: 'Формы подлиннее',
      xl: 'Формы с помощником: поля и чат в две колонки',
    };

    return (
      <>
        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          {(['sm', 'md', 'lg', 'xl'] as const).map((item) => (
            <Button key={item} variant="secondary" onClick={() => setSize(item)}>
              {item}
            </Button>
          ))}
        </Stack>

        <Modal
          isOpen={size !== undefined}
          onOpenChange={(open) => !open && setSize(undefined)}
          title={`Размер «${size ?? ''}»`}
          size={size}
          footer={<Button onClick={() => setSize(undefined)}>Понятно</Button>}
        >
          <Typography>{size ? purpose[size] : ''}</Typography>
        </Modal>
      </>
    );
  },
};

export const БезНижнейПанели: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Когда действий нет — окно только показывает. Крестик в углу остаётся ' +
          'всегда, как и закрытие по Escape.',
      },
    },
  },
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <>
        <Button variant="secondary" onClick={() => setIsOpen(true)}>
          Показать подробности
        </Button>

        <Modal
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          title="Расход по моделям"
          description="За последние 30 дней"
          size="md"
        >
          <Stack gap="var(--spacing-xs)">
            <Typography>claude-opus-4-8 — 18,7 млрд</Typography>
            <Typography>claude-fable-5 — 3,5 млрд</Typography>
            <Typography>claude-opus-4-7 — 14,3 млн</Typography>
          </Stack>
        </Modal>
      </>
    );
  },
};

export const ДлинноеСодержимое: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Прокручивается только тело: шапка и нижняя панель остаются на месте, ' +
          'а само окно не вырастает выше 85% высоты экрана.',
      },
    },
  },
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <>
        <Button variant="secondary" onClick={() => setIsOpen(true)}>
          Открыть длинное окно
        </Button>

        <Modal
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          title="Справка по хукам"
          size="md"
          footer={<Button onClick={() => setIsOpen(false)}>Закрыть</Button>}
        >
          <Stack gap="var(--spacing-md)">
            {Array.from({ length: 14 }, (_, index) => (
              <Typography key={index}>
                {index + 1}. Хук — это команда оболочки, привязанная к событию. PreToolUse
                срабатывает перед вызовом инструмента и может потребовать подтверждения, PostToolUse
                — после.
              </Typography>
            ))}
          </Stack>
        </Modal>
      </>
    );
  },
};
