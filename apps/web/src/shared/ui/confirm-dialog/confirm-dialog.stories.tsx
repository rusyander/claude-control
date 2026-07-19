import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ConfirmDialog } from './confirm-dialog';

/**
 * Подтверждение необратимого действия. Описание говорит, что именно исчезнет
 * и вернётся ли это, — иначе от подтверждения нет пользы.
 */
const meta = {
  title: 'Компоненты/ConfirmDialog',
  component: ConfirmDialog,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Спрашивать «Вы уверены?» бессмысленно: пользователь уверен, он же нажал. ' +
          'Полезно другое — сказать, что именно пропадёт и есть ли резервная копия. ' +
          'Поэтому описание обязательно.\n\n' +
          'У по-настоящему опасного удаления есть вторая ступень: ' +
          '`confirmationName` требует ввести имя дословно. Кнопка до этого ' +
          'недоступна — случайно проскочить нельзя.',
      },
    },
  },
  args: {
    isOpen: false,
    onOpenChange: () => undefined,
    onConfirm: () => undefined,
    title: 'Удалить безвозвратно?',
    description:
      'Хук будет удалён из settings.json. Файл скрипта останется на диске, но вызываться перестанет. Копия конфига сохранится в claude-control/backups.',
    confirmLabel: 'Удалить',
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычное: Story = {
  render: function Render(args) {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <>
        <Button
          variant="danger"
          leftIcon={<Icon name="trash" size={20} />}
          onClick={() => setIsOpen(true)}
        >
          Удалить хук
        </Button>
        <ConfirmDialog
          {...args}
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          onConfirm={() => setIsOpen(false)}
        />
      </>
    );
  },
};

export const СВводомИмени: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Вторая ступень для того, что не восстановить: папка скилла удаляется ' +
          'с диска целиком и резервной копии не остаётся. Кнопка оживает только ' +
          'после того, как имя введено дословно.',
      },
    },
  },
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <>
        <Button variant="danger" onClick={() => setIsOpen(true)}>
          Удалить скилл
        </Button>
        <ConfirmDialog
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          onConfirm={() => setIsOpen(false)}
          title="Удалить безвозвратно?"
          description="Папка скилла будет удалена с диска вместе со всеми файлами внутри. Это действие нельзя отменить: резервной копии папки не создаётся."
          confirmationName="frontend-architecture"
          confirmLabel="Удалить скилл"
        />
      </>
    );
  },
};

export const ВоВремяУдаления: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Пока запрос идёт, кнопка занята и повторное нажатие не проходит.',
      },
    },
  },
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <Stack direction="row" gap="var(--spacing-sm)">
        <Button variant="danger" onClick={() => setIsOpen(true)}>
          Открыть
        </Button>
        <ConfirmDialog
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          onConfirm={() => undefined}
          title="Удалить безвозвратно?"
          description="Сервер будет удалён из конфигурации. Инструменты этого сервера перестанут быть доступны Claude после перезапуска."
          confirmLabel="Удалить"
          isPending
        />
      </Stack>
    );
  },
};
