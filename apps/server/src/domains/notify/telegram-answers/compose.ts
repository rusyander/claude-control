import type { InboxClient } from '@agentdeck/contracts/chat-inbox';
import type {
  AskSourceInfo,
  ButtonAction,
  InlineButton,
  InlineKeyboard,
  ItemCard,
  PendingAskItem,
  SentItem,
  SentMessage,
} from './telegram-answers.types.ts';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { bold, code, escapeHtml, expandable, htmlToPlain } from './html.ts';

/**
 * Тексты и кнопки сообщений ответов из Telegram — разметка HTML (итоговый
 * формат владельца 25.10.2026 после живой проверки):
 *
 *   <b>❓ ВОПРОС · 📁 shop · Аудит проекта</b>
 *   <b>Перевести три задачи дальше?</b>
 *
 *   1. <b>Да</b> — <i>перевести все</i>
 *
 *   <a href="http://127.0.0.1:8888/chat?id=…">Открыть чат →</a>
 *
 * Первая строка — вид, проект за меткой «📁» и сессия (до 40 знаков): проект
 * в скобках в конце сливался с сессией, похожей на вопрос (живая проверка
 * 25.10). Чужой CLI, «VS Code» и «Терминал» — между ними: «📁 shop · Codex ·
 * Аудит проекта»; проекта нет — нет и метки. Вторая — суть, ровно один раз.
 * Варианты списком — только если хоть у одного есть описание, иначе хватает
 * кнопок. Вопрос сессии вне панели, который хук не держит, — без кнопок, со
 * строкой «Ответь в VS Code — отсюда ответ туда не дойдёт». Подробности — в
 * свёрнутой цитате, ссылка на чат — последней строкой. Хэштегов нет. Когда в
 * сообщении ответили на всё, оно сворачивается в строку итога: «✅ Разрешено
 * 15:54 · git push · 📁 shop · Аудит проекта».
 * Всё динамическое — под маской секретов, затем обрезано и экранировано.
 */

/** Предел сообщения Telegram — 4096; считаем вместе с тегами, с запасом. */
export const MESSAGE_LIMIT = 3900;
const QUESTION_LIMIT = 300;
/** Имя сессии в первой строке — чтобы строка помещалась в уведомление телефона. */
export const SESSION_LIMIT = 40;
/** Команда-суть второй строкой; длиннее — целиком в цитате. */
export const COMMAND_LIMIT = 80;
const DESCRIPTION_LIMIT = 200;
/** Суть и сессия в свёрнутой строке итога. */
const COLLAPSED_ESSENCE = 40;
const COLLAPSED_SESSION = 30;
const DETAIL_LIMIT = 600;
const LABEL_LIMIT = 48;
/** Тонкая черта между ожиданиями сводного сообщения. */
export const DIVIDER = '——————';

/**
 * Хост ссылки «Открыть чат →». Telegram не делает ссылкой `localhost`, а
 * `127.0.0.1` — да; Vite панели слушает именно его (`apps/web/vite.config.ts`).
 * Одна константа — сменить хост, если проверка владельца покажет иное.
 */
export const PANEL_LINK_HOST = '127.0.0.1';

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

/** Одной строкой и под маской: маска ищет сырой текст целиком, до обрезки. */
const flat = (text: string): string => maskSecretsInText(text).replace(/\s+/g, ' ').trim();

/** Маска секретов, затем обрезка, затем экранирование. */
const safe = (text: string, limit = Number.POSITIVE_INFINITY): string =>
  escapeHtml(clip(flat(text), limit));

/**
 * «📁 shop · Codex · Аудит проекта»: проект за меткой папки, CLI, если он не
 * Claude Code, и сессия до `limit` знаков. Пустое опускается. Уже экранировано.
 */
export function placeOf(
  session: string,
  project: string,
  via?: string,
  limit = SESSION_LIMIT,
): string {
  const name = session ? clip(flat(session), limit) : '';
  const folder = project.trim() ? `📁 ${project.trim()}` : '';
  return escapeHtml([folder, via?.trim() ?? '', name].filter(Boolean).join(' · '));
}

/** Первая строка жирным: «❓ ВОПРОС · 📁 shop · Аудит проекта». */
export function headLine(type: string, placeHtml: string): string {
  return bold(placeHtml ? `${escapeHtml(type)} · ${placeHtml}` : escapeHtml(type));
}

/** Вторая строка жирным — суть; длиннее предела — обрезана с хвостом. */
export function essenceLine(text: string, limit: number, tail = '…'): string {
  const whole = flat(text);
  return bold(escapeHtml(whole.length > limit ? `${whole.slice(0, limit)}${tail}` : whole));
}

/** Адрес чата в панели. */
export function panelLink(openId: string, port = process.env.WEB_PORT ?? '8888'): string {
  const base = `http://${PANEL_LINK_HOST}:${port}/chat`;
  return openId ? `${base}?id=${encodeURIComponent(openId)}` : base;
}

/** Строка-ссылка «Открыть чат →» — текстом: кнопкой Telegram такой адрес не принимает. */
export function linkLine(url: string): string {
  const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${href}">Открыть чат →</a>`;
}

/** Хвост сообщения: пустая строка и ссылка — последней, прямо над кнопками. */
export function withLink(lines: string[], url: string | undefined): string[] {
  return url ? [...lines, '', linkLine(url)] : lines;
}

/** Чужой CLI или сессия вне панели — в первую строку между проектом и сессией. */
function viaOf(source: AskSourceInfo): string {
  if (source.app === 'outside' && source.client === 'terminal') return 'Терминал';
  if (source.app === 'outside') return 'VS Code';
  return source.otherCli ? source.cli : '';
}

const ANSWER_THERE: { readonly [client in InboxClient]?: string } = {
  vscode: 'в VS Code',
  terminal: 'в терминале',
};

/** Строка вопроса только для чтения: где на него ответить. */
export function readOnlyLine(client: InboxClient | undefined): string {
  return `Ответь ${(client && ANSWER_THERE[client]) ?? 'на компьютере'} — отсюда ответ туда не дойдёт`;
}

/** Группа, стадия, «из фона» — в свёрнутую цитату. */
function groupOf(source: AskSourceInfo): string {
  const group = source.group;
  return [
    group ? `группа ${group.index}${group.title ? ` «${clip(group.title, 60)}»` : ''}` : '',
    group?.stage ? `стадия «${STAGE_TITLES[group.stage] ?? group.stage}»` : '',
    source.background ? 'из фона' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Запуск агента: что, каким агентом, на какой модели. */
function launchCode(item: PendingAskItem): string | undefined {
  if (!item.launch) return undefined;
  const { subagentType, model, effort, background } = item.launch;
  const how = [
    subagentType ? `агент ${subagentType}` : '',
    model ? `модель ${model}` : '',
    effort ? `усилие ${effort}` : '',
    background ? 'в фоне' : '',
  ].filter(Boolean);
  return how.length ? how.join(' · ') : undefined;
}

/**
 * Суть права: описание словами; нет своего описания (Bash без `description`) —
 * сама команда моноширинно; нет и команды — имя инструмента.
 */
function essenceOf(item: PendingAskItem): { text: string; isCode: boolean } {
  if (item.launch) return { text: item.launch.description ?? 'Запустить агента', isCode: false };
  if (item.description && item.description !== item.toolName) {
    return { text: item.description, isCode: false };
  }
  if (item.summary) return { text: item.summary, isCode: true };
  return { text: item.toolName ?? 'Разрешение', isCode: false };
}

/** Карточка ожидания: из чего соберётся разметка. */
export function cardOf(item: PendingAskItem): ItemCard {
  const { source } = item;
  const via = viaOf(source);
  const group = groupOf(source);
  const base = {
    project: source.project,
    session: source.chatTitle ? clip(flat(source.chatTitle), 200) : '',
    ...(via ? { via } : {}),
    ...(group ? { group } : {}),
  };
  const kind = item.target.kind;
  if (kind === 'outsideQuestion') {
    return { kind: 'question', ...base, readOnly: readOnlyLine(item.target.client) };
  }
  if (kind === 'question' || kind === 'relayQuestion') return { kind: 'question', ...base };
  const essence = essenceOf(item);
  const branch = kind === 'branchGate';
  const title = branch ? `Первая правка в основной копии: ${essence.text}` : essence.text;
  const details = item.launch ? launchCode(item) : item.summary;
  return {
    kind: kind === 'deferred' ? 'decision' : 'permission',
    ...base,
    title: clip(maskSecretsInText(title), 400),
    ...(essence.isCode && !branch ? { titleIsCode: true } : {}),
    ...(kind === 'deferred' ? { deferredId: item.target.id } : {}),
    ...(item.reason ? { reason: clip(maskSecretsInText(item.reason), 300) } : {}),
    ...(details ? { code: clip(maskSecretsInText(details), DETAIL_LIMIT) } : {}),
  };
}

interface RenderOptions {
  /** Номер в сводном сообщении; нет — сообщение об одном ожидании. */
  index?: number;
  link?: string;
  /** Свёрнутые подробности — снимаются, когда сообщение не влезает. */
  details: boolean;
}

const prefixOf = (options: RenderOptions): string =>
  options.index === undefined ? '' : `${options.index + 1} · `;

/** Место первой строки; у записей старше этого формата — прежняя строка «где». */
function placeOfCard(card: ItemCard, limit = SESSION_LIMIT): string {
  if (card.session === undefined && card.where) return escapeHtml(clip(card.where, limit));
  return placeOf(card.session ?? '', card.project, card.via, limit);
}

function questionBlock(item: SentItem, card: ItemCard, options: RenderOptions): string[] {
  const questions = item.questions ?? [];
  const step = Math.min(item.step ?? 0, Math.max(questions.length - 1, 0));
  const question = questions[step];
  const counter = questions.length > 1 ? ` ${step + 1}/${questions.length}` : '';
  const lines = [
    headLine(`${prefixOf(options)}❓ ВОПРОС${counter}`, placeOfCard(card)),
    essenceLine(question?.question || 'Агент задал вопрос', QUESTION_LIMIT, '…полностью в панели'),
  ];
  // Варианты списком — только когда есть что добавить к кнопкам: описание.
  // В сводном сообщении вопрос — одной кнопкой «Ответить», варианты — в отдельном.
  const described = question?.options.some((option) => option.description);
  if (question && options.index === undefined && described) {
    lines.push('');
    question.options.forEach((option, at) => {
      const label = bold(safe(option.label, 120));
      const detail = option.description ? ` — <i>${safe(option.description, 160)}</i>` : '';
      lines.push(`${at + 1}. ${label}${detail}`);
    });
  }
  if (card.readOnly) lines.push('', escapeHtml(card.readOnly));
  else if (question?.multiSelect && options.index === undefined) {
    lines.push('Можно выбрать несколько, затем «Готово».');
  }
  if (options.details && card.group) lines.push(expandable(safe(card.group)));
  return lines;
}

function decisionBlock(card: ItemCard, options: RenderOptions): string[] {
  const deferred = `⏳ ОТЛОЖЕНО${card.deferredId ? ` ${card.deferredId}` : ''}`;
  const type = card.kind === 'decision' ? deferred : '🔐 РАЗРЕШЕНИЕ';
  const title = flat(card.title ?? '');
  const essence = card.titleIsCode
    ? bold(code(escapeHtml(clip(title, COMMAND_LIMIT))))
    : bold(escapeHtml(clip(title, DESCRIPTION_LIMIT)));
  const lines = [headLine(`${prefixOf(options)}${type}`, placeOfCard(card)), essence];
  // Команда в цитате — только когда она не совпала со второй строкой: суть
  // словами, или сама команда обрезана там на 80 знаках.
  const command = card.code === undefined ? '' : flat(card.code);
  const cut = Boolean(card.titleIsCode) && title.length > COMMAND_LIMIT;
  const showCode = command !== '' && (command !== title || cut);
  const detail = [
    card.reason ? `Почему решаете вы: ${safe(card.reason)}` : '',
    showCode ? code(escapeHtml(card.code!)) : '',
    card.group ? safe(card.group) : '',
  ].filter(Boolean);
  if (options.details && detail.length) lines.push(expandable(detail.join('\n')));
  return lines;
}

/** Строка итога: «✅ Разрешено · 15:54» → эмодзи, слова, время. */
function outcomeParts(outcome: string): { emoji: string; words: string; time: string } {
  const match = /^(\S+)\s+(.*?)(?: · (\d\d:\d\d))?$/.exec(outcome);
  return { emoji: match?.[1] ?? '', words: match?.[2] ?? outcome, time: match?.[3] ?? '' };
}

/** Суть ожидания для строки итога — простым текстом. */
function collapsedEssence(item: SentItem): string {
  const card = item.card;
  if (!card) return clip(item.text.split('\n')[0] ?? '', COLLAPSED_ESSENCE);
  const raw =
    card.kind === 'question' ? (item.questions?.[0]?.question ?? 'Вопрос') : (card.title ?? '');
  return clip(flat(raw), COLLAPSED_ESSENCE);
}

/**
 * Ожидание с итогом — одной строкой: «✅ Разрешено 15:54 · git push · 📁 shop ·
 * Аудит проекта», «💻 Отвечено в панели 15:54 · …». Без кнопок и подробностей.
 * Суть остаётся: у D-n без чата и проекта иначе не осталось бы ничего, кроме итога.
 */
export function collapsedLine(item: SentItem): string {
  const { emoji, words, time } = outcomeParts(item.outcome ?? '');
  const head = `${emoji} ${words}${time ? ` ${time}` : ''}`.trim();
  const place = item.card ? placeOfCard(item.card, COLLAPSED_SESSION) : '';
  return [escapeHtml(head), escapeHtml(collapsedEssence(item)), place].filter(Boolean).join(' · ');
}

/** Одно ожидание разметкой — открытое или с итогом; ссылка — последней строкой. */
export function renderItem(item: SentItem, options: RenderOptions): string {
  const card = item.card;
  let lines: string[];
  if (!card) lines = [escapeHtml(item.text)];
  else if (card.kind === 'question') lines = questionBlock(item, card, options);
  else lines = decisionBlock(card, options);
  if (item.outcome) lines.push(escapeHtml(item.outcome));
  return withLink(lines, options.link).join('\n');
}

/** Ожидание в отправляемом сообщении: карточка для разметки и простой текст для записи. */
export function sentItemOf(item: PendingAskItem): SentItem {
  const sent: SentItem = {
    key: item.key,
    target: item.target,
    openId: item.openId,
    text: '',
    card: cardOf(item),
    ...(item.chat ? { chat: item.chat } : {}),
    ...(item.questions?.length ? { questions: item.questions, step: 0, picks: [] } : {}),
    state: 'open',
  };
  sent.text = htmlToPlain(renderItem(sent, { details: true }));
  return sent;
}

/** Простой текст ожидания на момент отправки. */
export function itemText(item: PendingAskItem): string {
  return sentItemOf(item).text;
}

/**
 * Последнее средство: разметка снимается, текст обрезается и экранируется
 * заново — валидный HTML без тегов, который Telegram примет как есть.
 */
function clipHtmlSafe(html: string): string {
  if (html.length <= MESSAGE_LIMIT) return html;
  let plain = htmlToPlain(html);
  while (escapeHtml(plain).length > MESSAGE_LIMIT) plain = plain.slice(0, -100);
  return escapeHtml(plain);
}

/**
 * Текст всего сообщения. Ответили на всё — сообщение сворачивается в строки
 * итога. Не влезает в предел (считаем с тегами) — сначала снимаются свёрнутые
 * подробности, потом последние ожидания уходят в строку «…и ещё N — в панели».
 * Резать разметку посредине нельзя: Telegram отвергнет незакрытый тег.
 */
export function messageText(message: SentMessage, links: readonly string[] = []): string {
  const resolved = message.items.every((item) => item.state !== 'open' && item.outcome);
  if (resolved) return clipHtmlSafe(message.items.map(collapsedLine).join('\n'));
  const many = message.items.length > 1;
  const build = (details: boolean, count: number): string => {
    const blocks = message.items.slice(0, count).map((item, index) =>
      renderItem(item, {
        details,
        ...(many ? { index } : {}),
        ...(links[index] ? { link: links[index] } : {}),
      }),
    );
    const head = many ? [bold(`Ждут ответа: ${message.items.length}`)] : [];
    const rest = message.items.length - count;
    const tail = rest > 0 ? [`…и ещё ${rest} — в панели`] : [];
    return [...head, blocks.join(`\n${DIVIDER}\n`), ...tail].filter(Boolean).join('\n\n');
  };
  for (const details of [true, false]) {
    const full = build(details, message.items.length);
    if (full.length <= MESSAGE_LIMIT) return full;
  }
  for (let count = message.items.length - 1; count >= 1; count -= 1) {
    const cut = build(false, count);
    if (cut.length <= MESSAGE_LIMIT) return cut;
  }
  return clipHtmlSafe(build(false, 1));
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
    // Только для чтения: ни вариантов, ни «Ответить» — отвечают там, где сессия.
    if (kind === 'outsideQuestion') return;
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
      const label = `${at + 1}. ${clip(option.label, LABEL_LIMIT)}`;
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

/** Строки итога — их видит человек под ответом (простой текст, экранируется при сборке). */
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

/** Просьба написать свой ответ — коротко: вопрос уже стоит выше в чате. */
export const CUSTOM_PROMPT_TEXT = '✍️ Напишите ответ ответом на это сообщение';

/** Ответ на просьбу без текста и подписи (картинки, стикер) — объяснение вместо тишины. */
export const MEDIA_REPLY_HINT =
  'Картинки из Telegram в ответ не передаются — напишите ответ текстом ответом на вопрос.';
