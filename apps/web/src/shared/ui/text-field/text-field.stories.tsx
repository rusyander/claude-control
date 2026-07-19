import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { TextField } from './text-field';

/**
 * Поле ввода с подписью, подсказкой и ошибкой. Подпись — обязательный проп:
 * поле без неё непонятно ни глазом, ни скринридером.
 */
const meta = {
  title: 'Формы/TextField',
  component: TextField,
  parameters: {
    docs: {
      description: {
        component:
          'Подпись обязательна и связана с полем — щелчок по ней ставит курсор. ' +
          'Подсказка объясняет формат заранее, ошибка появляется после проверки: ' +
          'это разные вещи и живут в разных пропсах.\n\n' +
          '`isMono` включает моноширинный шрифт — для путей, команд и ' +
          'идентификаторов, где важен каждый символ.',
      },
    },
  },
  // onChange здесь заглушка: каждая история подставляет своё состояние
  // в render — иначе поле не набиралось бы.
  args: {
    label: 'Имя файла',
    value: '',
    placeholder: 'например: git-guard.mjs',
    onChange: () => undefined,
  },
  argTypes: {
    multiline: { control: 'boolean' },
    isMono: { control: 'boolean' },
    disabled: { control: 'boolean' },
    rows: { control: { type: 'range', min: 2, max: 20 } },
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <TextField {...args} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычное: Story = {};

export const СПодсказкой: Story = {
  args: {
    label: 'Имя файла',
    hint: 'С расширением: .mjs для Node.js, .ps1 для PowerShell, .sh для оболочки.',
  },
};

export const СОшибкой: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Ошибка заменяет подсказку и подсвечивает рамку. Текст говорит, что ' +
          'сделать, а не только что не так.',
      },
    },
  },
  args: {
    label: 'Имя файла',
    value: 'мой скрипт',
    error: 'Пробелы в имени не поддерживаются — используйте дефис',
  },
};

export const Моноширинное: Story = {
  args: {
    label: 'Каталог конфигурации',
    value: 'C:\\Users\\rusyander\\.claude',
    isMono: true,
    hint: 'Определяется автоматически. Заполните, если каталог нестандартный.',
  },
};

export const Многострочное: Story = {
  args: {
    label: 'Текст правила',
    multiline: true,
    rows: 6,
    value:
      'ВСЁ, что видит пользователь, — только на русском языке: ответы, вопросы, ' +
      'варианты выбора, пункты списков и документы.',
    hint: 'Правило попадёт в CLAUDE.md и будет действовать во всех проектах.',
  },
};

export const Недоступное: Story = {
  args: {
    label: 'Идентификатор сессии',
    value: 'f36f23b8-def1-4451',
    disabled: true,
    isMono: true,
  },
};

export const Форма: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Несколько полей подряд — так они и стоят в окнах приложения.',
      },
    },
  },
  render: function Render() {
    const [name, setName] = useState('git-guard.mjs');
    const [description, setDescription] = useState('');
    const [command, setCommand] = useState('node "~/.claude/hooks/git-guard.mjs"');

    return (
      <Stack gap="var(--spacing-md)" style={{ maxWidth: 520 }}>
        <TextField label="Имя файла" value={name} onChange={setName} isMono />
        <TextField
          label="Описание"
          value={description}
          onChange={setDescription}
          multiline
          rows={3}
          placeholder="Зачем нужен этот скрипт"
          hint="Видно в списке скриптов — помогает вспомнить через месяц."
        />
        <TextField label="Команда" value={command} onChange={setCommand} isMono />
      </Stack>
    );
  },
};
