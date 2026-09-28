import { randomUUID } from 'node:crypto';
import type { Group } from '@agentdeck/contracts';
import type {
  PathStepDraftRequest,
  PathStepDraftResult,
  PathStepProposal,
} from '@agentdeck/contracts/group-path';
import { PATH_STEP_BLOCK_KIND, pathStepProposalSchema } from '@agentdeck/contracts/group-path';
import { readPanelJson, writePanelJson } from '../../lib/app-store/group-sources.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { globalCatalog } from './advice.ts';
import { readJsonBlock } from './answer-block.ts';
import { scriptsInventory } from './describe-views.ts';
import { GroupRequestError } from './errors.ts';
import type { GroupAsk, GroupModelMessage } from './model.ts';
import type { AgentImage } from '../../lib/agent-images.ts';
import { withAgentImagesNote } from '@agentdeck/contracts/agent-images';

/**
 * Ассистент шага «Пути»: сырой текст человека → шаг на двух языках, с
 * вопросами, похожими ресурсами и, может быть, предложением сделать шаг
 * глобальным ресурсом. Разговор многоходовый (человек отвечает на вопросы),
 * поэтому история хранится в `<appData>/group-path-drafts.json` по
 * `conversationId` — сам CLI one-shot памяти между вызовами не держит.
 *
 * Перевод (`translate`) идёт дешёвой ступенью и без вопросов: сторону правил
 * человек, модели остаётся только перевести вторую.
 */

const DRAFTS_FILE = 'group-path-drafts.json';
/** Сколько разговоров держать: черновики — не архив, старые вытесняются. */
const MAX_CONVERSATIONS = 50;

interface Conversation {
  groupId: string;
  messages: GroupModelMessage[];
  at: string;
}

type Drafts = Record<string, Conversation>;

function readDrafts(appData: string): Drafts {
  const raw = readPanelJson<unknown>(appData, DRAFTS_FILE, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Drafts) : {};
}

function saveDrafts(appData: string, drafts: Drafts): void {
  // Запись без `at` (правленный руками или старый файл) роняла сортировку —
  // и каждый круг отвечал 500 (F-263). Такая считается самой старой.
  const at = (entry: Conversation | undefined): string =>
    typeof entry?.at === 'string' ? entry.at : '';
  const kept = Object.entries(drafts)
    .sort((a, b) => at(b[1]).localeCompare(at(a[1])))
    .slice(0, MAX_CONVERSATIONS);
  writePanelJson(appData, DRAFTS_FILE, Object.fromEntries(kept));
}

/** Данные первого сообщения: режим, стадия, соседи, группа, опись ресурсов. */
export function draftContext(
  deps: EntityToggleDeps,
  group: Group,
  request: PathStepDraftRequest,
): string {
  const neighbours = (group.path?.steps ?? [])
    .filter((step) => step.anchor === request.anchor && step.id !== request.stepId)
    .sort((a, b) => a.order - b.order)
    .map((step) => `- ${step.title.en || step.title.ru}`);
  const saved = (group.path?.steps ?? []).find((step) => step.id === request.stepId);
  // Шаг из окна важнее сохранённого: сохранённый — ДО правки человека.
  const edited = request.current ?? saved;
  // У сценария стадий нет: «после стадии work» и конвейер в описании шага
  // были бы неправдой, и ассистент писал бы шаг под чужую рамку.
  const isScenario = group.flow === 'scenario';
  const place = request.within
    ? `Inside the skill \`${request.within.skillId}\`, ${
        request.within.after
          ? `right after its step "${request.within.after}"`
          : 'before its first step'
      } (runs as part of that skill, not as a separate turn)`
    : isScenario
      ? 'Flow: scenario (an ordered list of steps, no built-in stages)'
      : `After stage: ${request.anchor}`;
  return [
    `Mode: ${request.mode}`,
    place,
    `Group: ${group.name}${group.when ? ` — ${group.when}` : ''}`,
    isScenario
      ? `Scenario steps so far, in order:\n${neighbours.join('\n') || '(none)'}`
      : `Other steps after this stage:\n${neighbours.join('\n') || '(none)'}`,
    ...(edited && request.mode === 'translate'
      ? [
          `Step now: ${JSON.stringify({ title: edited.title, prompt: edited.prompt, gate: edited.gate })}`,
        ]
      : []),
    `Edited side: ${request.lang}`,
    `Person's text:\n${request.text}`,
    ...(request.mode === 'author'
      ? [`Existing resources:\n${globalCatalog(deps, new Set())}`]
      : []),
  ].join('\n\n');
}

/** Ответ модели → предложение; у перевода лишнего быть не может. */
export function readProposal(reply: string, mode: PathStepDraftRequest['mode']): PathStepProposal {
  const parsed = pathStepProposalSchema.safeParse(readJsonBlock(reply, PATH_STEP_BLOCK_KIND));
  if (!parsed.success) {
    throw new GroupRequestError(502, 'model_unreadable', 'group-model-unreadable');
  }
  if (mode === 'author') return parsed.data;
  const { title, prompt, gate } = parsed.data;
  return { similar: [], questions: [], title, prompt, ...(gate ? { gate } : {}) };
}

/**
 * Дописывает предложение после разбора: `raw` — разобранный блок ответа модели
 * (там то, что схема предложения не держит, — сводки у совпадений).
 */
export type ProposalEnrich = (proposal: PathStepProposal, raw: unknown) => PathStepProposal;

export async function draftPathStep(
  deps: EntityToggleDeps,
  ask: GroupAsk,
  prompt: string,
  group: Group,
  request: PathStepDraftRequest,
  makeId: () => string = randomUUID,
  enrich?: ProposalEnrich,
  /** Картинки реплики человека — только в этот запрос к модели. */
  images: readonly AgentImage[] = [],
): Promise<PathStepDraftResult> {
  const drafts = readDrafts(deps.paths.appData);
  const isTranslate = request.mode === 'translate';
  const previous = request.conversationId ? drafts[request.conversationId] : undefined;
  // Чужой разговор (другая группа) не продолжается: история другой группы
  // подсунула бы модели не те соседние шаги. Перевод не продолжает разговор
  // никогда: продолжение шлёт модели только текст, и она, помня режим
  // `author`, приняла бы правленую сторону за ответ на свои вопросы.
  const conversation =
    !isTranslate && previous && previous.groupId === group.id ? previous : undefined;
  const conversationId = conversation
    ? request.conversationId!
    : isTranslate && previous && previous.groupId === group.id
      ? request.conversationId!
      : makeId();

  // Скриптов в общей описи нет — без этой строки шаг не мог бы указать на готовый скрипт.
  const scripts =
    request.mode === 'author' ? `\n\nExisting scripts:\n${scriptsInventory(deps)}` : '';
  const messages: GroupModelMessage[] = conversation
    ? [...conversation.messages, { role: 'user', content: request.text }]
    : [
        {
          role: 'user',
          content: `${prompt.trim()}\n\n${draftContext(deps, group, request)}${scripts}\n`,
        },
      ];

  // Картинки — только в запрос: в историю разговора ложится текст, иначе
  // base64 оседал бы в файле черновиков и ехал бы заново каждым кругом.
  const last = messages[messages.length - 1]!;
  const asked: GroupModelMessage[] =
    images.length > 0 ? [...messages.slice(0, -1), { ...last, images }] : messages;
  const reply = await ask(asked, request.mode === 'translate' ? 'cheap' : 'default');
  const parsed = readProposal(reply, request.mode);
  const proposal =
    enrich && request.mode === 'author'
      ? enrich(parsed, readJsonBlock(reply, PATH_STEP_BLOCK_KIND))
      : parsed;

  // Перевод в историю разговора не пишется: следующий круг `author` продолжает
  // разговор с ассистентом, а не с переводчиком.
  if (!isTranslate) {
    // Файл перечитывается ПОСЛЕ ответа модели: прочитанный до вызова снимок
    // стирал разговоры, записанные за время ожидания (F-262).
    const fresh = readDrafts(deps.paths.appData);
    fresh[conversationId] = {
      groupId: group.id,
      // Имена картинок — строкой в тексте: следующий круг знает, что картинка
      // была, хотя самой картинки уже не видит.
      messages: [
        ...messages.slice(0, -1),
        {
          ...last,
          content: withAgentImagesNote(
            last.content,
            images.map((image) => image.name),
          ),
        },
        { role: 'assistant', content: reply },
      ],
      at: new Date().toISOString(),
    };
    saveDrafts(deps.paths.appData, fresh);
  }
  return { conversationId, proposal };
}
