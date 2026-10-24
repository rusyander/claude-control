import type {
  ButtonAction,
  InlineButton,
  InlineKeyboard,
  PendingAskItem,
  SentItem,
  SentMessage,
} from './telegram-answers.types.ts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';

/**
 * Тексты и кнопки сообщений ответов из Telegram. Читает их человек вдали от
 * стола — поэтому по-русски, коротко и с ответом на главное: чей вопрос, что
 * именно спрошено и куда нажать.
 *
 * Содержимое вопроса уходит наружу (команда, путь, текст вопроса) — иначе
 * отвечать было бы не на что; секреты в нём уже под маской (`collect.ts`).
 */

/** Предел текста сообщения Telegram — 4096; запас под строки итога. */
const MESSAGE_LIMIT = 3900;
const ITEM_LIMIT = 900;
const LABEL_LIMIT = 48;

const STAGE_TITLES: Record<string, string> = {
  work: 'работа',
  review: 'ревью',
  deliver: 'доставка',
  fix: 'правки',
};

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** «19:52» — местное время машины панели. */
export function clock(at: number = Date.now()): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function titleOf(item: PendingAskItem): string {
  switch (item.target.kind) {
    case 'branchGate':
      return '🌿 Первая правка в основной копии';
    case 'question':
    case 'relayQuestion':
      return '❓ Агент задал вопрос';
    case 'deferred':
      return `⏳ Отложенный вопрос ${item.target.id}`;
    default:
      return item.launch ? '🚀 Запуск агента' : '🔐 Нужно разрешение';
  }
}

/** Строки источника: проект, чат, приложение и CLI, группа со стадией. */
export function sourceLines(item: PendingAskItem): string[] {
  const { source } = item;
  const where = [
    source.project ? `📁 ${source.project}` : '',
    source.chatTitle ? `💬 ${clip(source.chatTitle, 80)}` : '',
    source.app === 'outside' ? `${source.cli}, вне панели` : source.cli,
    source.background ? 'из фона' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [where];
  if (source.group) {
    const { index, title, stage, parentTitle } = source.group;
    lines.push(
      [
        `👥 Группа ${index}${title ? ` «${clip(title, 60)}»` : ''}`,
        stage ? `стадия «${STAGE_TITLES[stage] ?? stage}»` : '',
        parentTitle ? `из «${clip(parentTitle, 60)}»` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
  return lines;
}

/** Что спрошено: запуск агента — его подробности, иначе инструмент и его вход. */
function bodyLines(item: PendingAskItem): string[] {
  const lines: string[] = [];
  if (item.launch) {
    const { description, subagentType, model, effort, background } = item.launch;
    if (description) lines.push(`Что: ${clip(description, 200)}`);
    const how = [
      subagentType ? `агент ${subagentType}` : '',
      model ? `модель ${model}` : '',
      effort ? `усилие ${effort}` : '',
      background ? 'в фоне' : '',
    ].filter(Boolean);
    if (how.length) lines.push(how.join(' · '));
  }
  if (item.reason) lines.push(`Почему решаете вы: ${clip(item.reason, 300)}`);
  if (item.summary) {
    lines.push(item.toolName ? `${item.toolName}: ${item.summary}` : item.summary);
  } else if (item.toolName && !item.launch) {
    lines.push(item.toolName);
  }
  return lines;
}

/** Текст ожидания при отправке — он и остаётся в сообщении после ответа. */
export function itemText(item: PendingAskItem): string {
  return clip([titleOf(item), ...sourceLines(item), ...bodyLines(item)].join('\n'), ITEM_LIMIT);
}

/** Текущий вопрос вызова `AskUserQuestion` — для открытого ожидания-вопроса. */
function questionLines(item: SentItem): string[] {
  const questions = item.questions ?? [];
  const step = item.step ?? 0;
  const question = questions[step];
  if (!question) return [];
  const lines = [
    questions.length > 1 ? `Вопрос ${step + 1} из ${questions.length}:` : '',
    `${question.header ? `${question.header}: ` : ''}${question.question}`,
    ...question.options.map(
      (option) =>
        `• ${option.label}${option.description ? ` — ${clip(option.description, 120)}` : ''}`,
    ),
    question.multiSelect ? 'Можно выбрать несколько, затем «Готово».' : '',
  ];
  // Вопрос и варианты пишет модель — секрет мог попасть и туда.
  return lines.filter(Boolean).map((line) => maskSecretsInText(line));
}

/** Ссылка на ожидание в панели — текстом: кнопкой Telegram адрес localhost не принимает. */
export function panelLink(openId: string, port = process.env.WEB_PORT ?? '8888'): string {
  const base = `http://localhost:${port}/chat`;
  return openId ? `${base}?id=${encodeURIComponent(openId)}` : base;
}

/** Текст всего сообщения по нынешнему состоянию его ожиданий. */
export function messageText(message: SentMessage, links: readonly string[]): string {
  const many = message.items.length > 1;
  const blocks = message.items.map((item, index) => {
    const lines = [many ? `${index + 1}. ${item.text}` : item.text];
    if (item.state === 'open') lines.push(...questionLines(item));
    if (item.outcome) lines.push(item.outcome);
    return lines.join('\n');
  });
  const head = many ? [`Ждут ответа: ${message.items.length}`] : [];
  const tail = [...new Set(links)].map((link) => `Открыть в панели: ${link}`);
  return clip([...head, ...blocks, ...tail].join('\n\n'), MESSAGE_LIMIT);
}

/** Номер действия: тот же для той же кнопки — кнопки соседей не меняются при правке. */
export function actionNumber(message: SentMessage, action: ButtonAction): number {
  for (const [n, known] of Object.entries(message.actions)) {
    if (
      known.item === action.item &&
      known.act === action.act &&
      known.option === action.option &&
      known.step === action.step
    ) {
      return Number(n);
    }
  }
  const n = message.nextAction;
  message.actions[String(n)] = action;
  message.nextAction = n + 1;
  return n;
}

/** Кнопки открытых ожиданий. `sign` — подпись номера действия (`callback-data.ts`). */
export function keyboardOf(message: SentMessage, sign: (n: number) => string): InlineKeyboard {
  const many = message.items.length > 1;
  const rows: InlineKeyboard = [];
  const button = (
    index: number,
    text: string,
    action: Omit<ButtonAction, 'item'>,
  ): InlineButton => ({
    text: clip(many ? `${index + 1} · ${text}` : text, LABEL_LIMIT + 6),
    callback_data: sign(actionNumber(message, { item: index, ...action })),
  });
  message.items.forEach((item, index) => {
    if (item.state !== 'open') return;
    const kind = item.target.kind;
    if (kind === 'branchGate') {
      rows.push([
        button(index, '✍️ Писать здесь', { act: 'here' }),
        button(index, '⛔ Не писать', { act: 'stop' }),
      ]);
      return;
    }
    if (kind !== 'question' && kind !== 'relayQuestion') {
      rows.push([
        button(index, '✅ Разрешить', { act: 'allow' }),
        button(index, '⛔ Запретить', { act: 'deny' }),
      ]);
      return;
    }
    // Вопрос в сводном сообщении — одной кнопкой: варианты всех вопросов разом
    // превратили бы клавиатуру в стену. Нажатие выносит его отдельным сообщением.
    if (many) {
      rows.push([button(index, '❓ Ответить', { act: 'expand' })]);
      return;
    }
    const step = item.step ?? 0;
    const question = item.questions?.[step];
    if (!question) return;
    const picked = item.picks?.[step] ?? [];
    question.options.forEach((option, at) => {
      const label = clip(option.label, LABEL_LIMIT);
      rows.push([
        question.multiSelect
          ? button(index, `${picked.includes(option.label) ? '☑' : '☐'} ${label}`, {
              act: 'toggle',
              option: at,
              step,
            })
          : button(index, label, { act: 'pick', option: at, step }),
      ]);
    });
    const last = [button(index, '✍️ Свой ответ', { act: 'custom', step })];
    if (question.multiSelect) last.unshift(button(index, '✅ Готово', { act: 'done', step }));
    rows.push(last);
  });
  return rows;
}

/** Строки итога — их видит человек под ответом. */
export const OUTCOME = {
  allowed: (at?: number) => `✅ Разрешено · ${clock(at)}`,
  denied: (at?: number) => `⛔ Запрещено · ${clock(at)}`,
  here: (at?: number) => `✍️ Писать здесь · ${clock(at)}`,
  stop: (at?: number) => `⛔ Не писать · ${clock(at)}`,
  answer: (text: string, at?: number) => `✅ Ответ: ${clip(text, 300)} · ${clock(at)}`,
  inPanel: (at?: number) => `💻 Отвечено в панели · ${clock(at)}`,
  stale: (at?: number) => `⌛ Уже не актуально · ${clock(at)}`,
  deferred: (id: string, at?: number) => `⏳ Отложено как ${id} · ${clock(at)}`,
  expanded: () => '➡️ Ниже отдельным сообщением',
} as const;

/** Ответы на нажатия — всплывающая строка Telegram. */
export const TOAST = {
  answered: 'Уже отвечено',
  stale: 'Уже не актуально',
  accepted: 'Принято',
  failed: 'Не получилось — откройте панель',
  customPrompt: 'Напишите ответ в ответ на сообщение ниже',
  pickFirst: 'Сначала выберите хотя бы один вариант',
  next: 'Принято — следующий вопрос',
} as const;

export function customPromptText(item: SentItem): string {
  const question = item.questions?.[item.step ?? 0];
  return `✍️ Свой ответ${question ? ` на «${clip(question.question, 200)}»` : ''}: напишите его ответом на это сообщение.`;
}
