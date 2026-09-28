import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import {
  ImageAttachButton,
  ImageAttachTray,
  ImageAttachZone,
  SentImageNames,
} from './image-attach';
import { useImageAttach } from './useImageAttach';

/**
 * Картинки в поле агента: кнопка, перетаскивание и вставка Ctrl+V. Одно
 * поведение во всех полях панели — агент панели, помощники форм и структуры,
 * ассистент шага группы, чат чужого CLI.
 */
const meta = {
  title: 'Компоненты/ImageAttach',
  component: ImageAttachTray,
  parameters: {
    docs: {
      description: {
        component:
          'Картинку прикладывают тремя путями — кнопкой, перетаскиванием в поле и вставкой ' +
          'из буфера. Отказ звучит в момент вложения и словами: имя файла, его настоящий ' +
          'размер и предел (20 МБ, как у чата), не больше восьми картинок в сообщении. ' +
          'Крупный снимок фронт ужимает сам до предела модели — человек этот предел не ' +
          'встречает.\n\nВ ленте ушедшие картинки видны именами (`SentImageNames`).',
      },
    },
  },
} satisfies Meta<typeof ImageAttachTray>;

export default meta;

type Story = StoryObj<typeof meta>;

function Field() {
  const attach = useImageAttach();
  return (
    <Stack gap="var(--spacing-xs)" style={{ maxWidth: 420 }}>
      <ImageAttachTray attach={attach} />
      <ImageAttachZone attach={attach}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <textarea rows={3} style={{ flex: 1 }} placeholder="Вставьте снимок Ctrl+V" />
          <ImageAttachButton attach={attach} />
        </Stack>
      </ImageAttachZone>
    </Stack>
  );
}

/** Живое поле: приложите картинку любым из трёх путей. */
export const Playground: Story = {
  args: { attach: undefined as never },
  render: () => <Field />,
};

/** Имена картинок в реплике ленты. */
export const Sent: Story = {
  args: { attach: undefined as never },
  render: () => <SentImageNames names={['screen.png', 'pasted-20260927-090507.png']} />,
};
