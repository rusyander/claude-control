import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import type { StreamState } from '@entities/Chat/model/useChatStream';

/**
 * Данные для витрины.
 *
 * Живут в приложении, а не в отдельной папке историй, намеренно: они
 * типизированы теми же контрактами, что и настоящие ответы сервера, поэтому
 * при изменении контракта витрина перестанет собираться — и это правильно.
 * Придуманные «на глазок» объекты в историях такой связи не дают и тихо
 * расходятся с реальностью.
 *
 * Даты фиксированные: иначе снимки историй отличались бы от прогона к прогону.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-19T12:40:00Z').getTime();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

export const mockChats: ChatSummary[] = [
  {
    id: 'b7885d2b-5f36-4180-878e-f9123af099f7',
    title: 'Поправь проблемы в чате: отправка и потеря сессии',
    project: 'C--work-claude-control',
    projectPath: 'C:\\work\\claude-control',
    isSandbox: false,
    messageCount: 170,
    createdAt: ago(3 * 60 * 60 * 1000),
    updatedAt: ago(2 * 60 * 1000),
    preview: 'Все проверки прошли: отправка из пустого состояния, продолжение после перезагрузки.',
    model: 'claude-opus-4-8',
  },
  {
    id: 'f36f23b8-def1-4451-9e8a-8e4ca3f02c99',
    title: '# ТЗ: настройка глобальных MCP-серверов (GitLab + Jira)',
    project: 'C--Users-rusyander',
    projectPath: 'C:\\Users\\rusyander',
    isSandbox: false,
    messageCount: 209,
    createdAt: ago(5 * 60 * 60 * 1000),
    updatedAt: ago(26 * 60 * 1000),
    preview: 'Серверы отвечают: 98, 115 и 4 инструмента соответственно.',
    model: 'claude-opus-4-8',
  },
  {
    id: 'ddead524-42f4-4ba6-ac22-bacb224798d5',
    title: 'Собери страницу с графиком по этим данным',
    project: 'claude-control-chats-new',
    projectPath: 'C:\\Users\\rusyander\\.claude-control\\chats\\new-1784455113488',
    isSandbox: true,
    messageCount: 8,
    createdAt: ago(DAY),
    updatedAt: ago(DAY),
    preview: 'Готово: page.html с графиком и переключателем периода.',
    model: 'claude-opus-4-8',
  },
  {
    id: '9cd187b0-a69e-432f-a7d7-1707a91c2865',
    title: 'Открой проект, где мы работали над распознаванием речи',
    project: 'd--Work-MY-PROJECTS',
    projectPath: 'D:\\Work\\MY-PROJECTS\\speech',
    isSandbox: false,
    messageCount: 39,
    createdAt: ago(2 * DAY),
    updatedAt: ago(2 * DAY),
    preview: 'Нашёл: проект speech-to-text, последняя правка две недели назад.',
    model: 'claude-fable-5',
  },
  {
    id: '57a22f10-d85a-4626-b698-8c8bbc1b2b3b',
    title: 'Разбери книгу по главам и сделай конспект',
    project: 'docs-ai',
    projectPath: 'D:\\Work\\docs-ai',
    isSandbox: false,
    messageCount: 191,
    createdAt: ago(9 * DAY),
    updatedAt: ago(9 * DAY),
    preview: 'Двадцать третья и двадцать четвёртая главы готовы.',
    model: 'claude-opus-4-8',
  },
];

export const mockMessages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    blocks: [
      {
        type: 'text',
        text: 'Собери страницу с графиком расхода по дням и кнопкой переключения периода.',
      },
    ],
    timestamp: ago(12 * 60 * 1000),
  },
  {
    id: 'm2',
    role: 'assistant',
    blocks: [
      {
        type: 'thinking',
        text: 'Нужен один файл без зависимостей: график рисую на SVG, данные кладу инлайном.',
      },
      {
        type: 'tool',
        name: 'Write',
        input: '{"file_path":"page.html","content":"<!doctype html>…"}',
      },
      {
        type: 'text',
        text:
          'Готово — `page.html`.\n\n' +
          '- график на SVG, без внешних библиотек\n' +
          '- переключатель периода: **7 / 30 / 90 дней**\n' +
          '- тёмная и светлая темы через `prefers-color-scheme`\n\n' +
          'Открыть можно во вкладке предпросмотра справа.',
      },
    ],
    timestamp: ago(11 * 60 * 1000),
  },
  {
    id: 'm3',
    role: 'user',
    blocks: [{ type: 'text', text: 'Добавь подпись значений прямо у точек.' }],
    timestamp: ago(4 * 60 * 1000),
  },
];

export const mockArtifacts: Artifact[] = [
  {
    name: 'page.html',
    path: 'C:\\Users\\rusyander\\.claude-control\\chats\\new-1784455113488\\page.html',
    kind: 'html',
    sizeBytes: 8_421,
    modifiedAt: ago(11 * 60 * 1000),
    hasSource: true,
  },
  {
    name: 'notes.md',
    path: 'C:\\Users\\rusyander\\.claude-control\\chats\\new-1784455113488\\notes.md',
    kind: 'markdown',
    sizeBytes: 612,
    modifiedAt: ago(10 * 60 * 1000),
    hasSource: true,
  },
];

/** Состояние потока: ответ, который набирается прямо сейчас. */
export const mockStream: Record<'idle' | 'typing' | 'working' | 'failed', StreamState> = {
  idle: { text: '', thinking: '', tools: [], isRunning: false },
  typing: {
    text: 'Добавляю подписи значений: они встанут над точками и не будут',
    thinking: '',
    tools: [],
    isRunning: true,
  },
  working: {
    text: '',
    thinking: 'Правлю разметку графика: подписи нужно сместить, чтобы не наезжали на линию.',
    tools: [{ name: 'Read', input: '{"file_path":"page.html"}' }],
    isRunning: true,
  },
  failed: {
    text: '',
    thinking: '',
    tools: [],
    isRunning: false,
    error: 'No conversation found with session ID: f36f23b8-def1-4451-9e8a-8e4ca3f02c99',
  },
};
