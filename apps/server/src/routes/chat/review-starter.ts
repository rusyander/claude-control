import { statSync } from 'node:fs';
import type { ServerContext } from '../../context.ts';
import {
  DEFAULT_PROVIDER_ID,
  isKnownProviderId,
  getProvider,
  getActiveProvider,
} from '../../providers/registry.ts';
import { parseForeignChatKey, foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { initiativePrompt } from '../../domains/chat/initiative/initiative.ts';
import { createChat } from '../../domains/provider-chat/provider-chat.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { RunMeta } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { SplitLaunchDeps } from './split-launch.ts';
import {
  activateGroupsQuietly,
  groupsActivatedNotice,
} from '../../domains/group-activation/group-activation.ts';
import { activeCliCommand } from '../../providers/cli/cli.ts';
import { AUTONOMOUS_PERMISSION_MODE } from '../../domains/chat/ChatWorkspace/ChatWorkspace.ts';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';
import { findTranscript } from '../../domains/chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { projectsDir } from './paths.ts';

/** Что домен ревью просит запустить: правки по замечаниям или их отправку в MR. */
export interface ReviewStageStart {
  chatId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  stage: 'fix' | 'push' | 'review' | 'tell';
  fromAliases: string[];
  title?: string;
  /** Продолжить этот разговор, а не заводить новый (Д8 push, Д4 повтор итога, Д7 слово родителя). */
  resume?: { sessionId: string };
  /** Вводная на случай, когда продолжить разговор нельзя: его файла на диске нет. */
  fresh?: string;
}

/**
 * Какую сессию продолжать: ту, чей файл ещё на диске, — из просимой и всех
 * ключей того же разговора, свежайшую. Нет ни одной — продолжать нечего, и
 * `--resume` дал бы «No conversation found» (вопрос ревью Q2: транскрипт группы
 * удалён мимо панели, доставленная группа «падала» на каждом нажатии).
 */
export function resumableSession(
  dir: string,
  wanted: string,
  aliases: readonly string[],
): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const id of new Set([wanted, ...aliases])) {
    if (id.startsWith('new-')) continue;
    const file = findTranscript(dir, id);
    if (!file) continue;
    const at = statSync(file).mtimeMs;
    if (!best || at > best.at) best = { id, at };
  }
  return best?.id;
}

/** Вводная без подробностей группы — у стадий, что их не передали. */
const LOST_FALLBACK =
  'The panel could not continue your previous conversation in this folder: its transcript is ' +
  'gone (deleted outside the panel). This is a new conversation — restore the context from the ' +
  'facts: git status and git log.';

/** Заметка человеку в чат группы: прежний разговор потерян, ход пошёл новым. */
function conversationLostNotice(lost: string): ChatEvent {
  return {
    kind: 'notice',
    code: 'conversationLost',
    text: serverText('chat-conversation-lost-notice', { lost }),
    textCode: 'chat-conversation-lost-notice',
    textParams: { lost },
  };
}

/**
 * Та же стадия ревью, но у чужого CLI (Т6).
 *
 * Разница ровно одна и она про ключи: разговор заводит хранилище провайдера,
 * оно же и выдаёт идентификатор, — поэтому наружу уходит НАСТОЯЩИЙ ключ
 * (`codex:c1a2…`), и связь, написанную доменом под временным, он переносит на
 * него сам. Права здесь не тумблер: чужому CLI панель ничего не разрешает
 * сверх того, чем он настроен.
 */
export function startForeignReviewStage(
  ctx: ServerContext,
  deps: SplitLaunchDeps,
  providerId: string,
  input: ReviewStageStart,
): { started: boolean; chatId?: string; busy?: boolean } {
  // Claude сюда не попадает никогда, незнакомый провайдер — тем более:
  // `getProvider` откатился бы на Claude и запустил чужую ветку не тем CLI.
  if (providerId === DEFAULT_PROVIDER_ID || !isKnownProviderId(providerId)) {
    return { started: false };
  }
  const provider = getProvider(providerId);
  const appData = ctx.location.paths.appData;
  // Группы проекта тумблером Claude здесь НЕ включаются: чужой CLI файлов Claude
  // не читает. Привязанные к проекту едут слоем на прогон при отправке ниже.

  // Продолжение того же разговора (Д8, Д4): чат уже есть в хранилище.
  const resumed = input.resume ? parseForeignChatKey(input.resume.sessionId) : undefined;
  if (resumed) {
    const initiative = initiativePrompt(ctx.store.getSettings(), {
      splitMuted: true,
      foreign: true,
    });
    const sent = deps.providerChats.send(
      appData,
      providerId,
      resumed.chatId,
      { text: input.prompt },
      {
        provider,
        models: ctx.models.current(provider.modelVendors ?? []).models,
        ...(initiative ? { systemPrefix: initiative } : {}),
      },
    );
    return sent.ok
      ? { started: true, chatId: input.resume!.sessionId }
      : { started: false, ...(sent.reason === 'already_running' ? { busy: true } : {}) };
  }

  const word = input.stage === 'fix' ? 'правки' : input.stage === 'review' ? 'ревью' : 'отправка';
  const created = createChat(appData, providerId, {
    title: input.title ? `${input.title} · ${word}` : word,
    workdir: input.cwd,
    // Модель — та же, что вела ревью-группу: список замечаний уже превратил
    // неизвестное в понятное, и менять ступень под правки не за что.
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    // Как у Claude: стадия ревью по ссылке идёт с автономными правами.
    allowEdits: true,
  });
  if (!created) return { started: false };

  const chatKey = foreignChatKey(providerId, created.id);
  // Дерево на паузе — разговор заведён, но не запущен: старт лёг в очередь и
  // уйдёт по «Продолжить всё». Решение человека при этом не теряется.
  if (
    deps.gate?.defer(
      'stage',
      chatKey,
      { prompt: input.prompt, cwd: input.cwd } as RunOptions,
      { projectPath: input.cwd } as RunMeta,
    )
  ) {
    return { started: true, chatId: chatKey };
  }

  const initiative = initiativePrompt(ctx.store.getSettings(), { splitMuted: true, foreign: true });
  const outcome = deps.providerChats.send(
    appData,
    providerId,
    created.id,
    { text: input.prompt },
    {
      provider,
      models: ctx.models.current(provider.modelVendors ?? []).models,
      ...(initiative ? { systemPrefix: initiative } : {}),
    },
  );
  return { started: outcome.ok, chatId: chatKey };
}

/**
 * Запуск стадии ревью по ссылке (Т7): правки по замечаниям и отправка их в MR.
 *
 * Отдельно от `createSplitLauncher`, потому что момент другой: решение приходит
 * через часы после разделения, из хаба или с телефона, и «того самого» запроса с
 * его моделью и правами уже нет. Всё, что нужно, лежит в связи чата ревью, а
 * недостающее берётся из настроек панели.
 *
 * Права — авторежим (`AUTONOMOUS_PERMISSION_MODE`), и это не вольность: человек нажал «исправить
 * в копии». Без них агент встал бы на первом же файле, дожидаясь у панели того,
 * кто уже ответил.
 */
export function createReviewStarter(
  ctx: ServerContext,
  deps: SplitLaunchDeps,
): (input: ReviewStageStart) => { started: boolean; chatId?: string; busy?: boolean } {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  return (input) => {
    if (!input.cwd) return { started: false };

    // Чей это разговор, решают КЛЮЧИ закончившегося ревью, а не активный
    // провайдер: карточка ждала человека часами, и за это время он мог
    // переключить CLI. Запустить правки чужой группы через Claude значило бы
    // отдать чужую ветку не тому агенту.
    const foreign = input.fromAliases.map((key) => parseForeignChatKey(key)).find(Boolean);
    if (foreign) return startForeignReviewStage(ctx, deps, foreign.providerId, input);
    // У Claude команда запуска берётся из настроек панели, и при чужом активном
    // провайдере это была бы команда чужого CLI с флагами Claude.
    if (getActiveProvider(ctx.store).id !== DEFAULT_PROVIDER_ID) return { started: false };

    const settings = ctx.store.getSettings();
    const activated = activateGroupsQuietly(
      { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
      input.cwd,
      (error) => deps.log.warn({ err: error }, 'group activation failed'),
    );
    const wanted = input.resume?.sessionId;
    const sessionId = wanted
      ? resumableSession(projectsDir(ctx), wanted, input.fromAliases)
      : undefined;
    // Файла сессии нет — новый разговор под тем же ключом: настоящий ключ он
    // получит своим первым ходом, и связь с группой переедет на него сама.
    const lost = wanted && !sessionId ? wanted : undefined;
    // Продолжение того же разговора (Д8, Д4): второй прогон поверх идущего —
    // это два агента в одной копии, поэтому отказ с причиной.
    if (wanted && deps.runs.isRunning(input.chatId, sessionId ?? wanted)) {
      return { started: false, busy: true };
    }
    deps.runs.muteSplit(input.chatId);
    // Тумблеры наследует только НОВЫЙ разговор: у продолженного они свои.
    if (!wanted && input.fromAliases.length > 0) {
      deps.session.inherit(input.fromAliases, input.chatId);
    }

    const initiative = initiativePrompt(settings, { splitMuted: true });
    const options = {
      prompt: lost
        ? `${input.fresh ?? LOST_FALLBACK}

${input.prompt}`
        : input.prompt,
      ...(sessionId ? { sessionId } : {}),
      cwd: input.cwd,
      command: activeCliCommand(ctx.store),
      model: input.model || settings.chatModel,
      effort: input.effort || settings.chatEffort,
      permissionMode: AUTONOMOUS_PERMISSION_MODE,
      permissionPrompt: { runId: input.chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
      ...(initiative ? { appendSystemPrompt: initiative } : {}),
    };
    const meta = {
      origin: 'groups' as const,
      projectPath: input.cwd,
      ...(sessionId ? { sessionId } : {}),
    };
    // Дерево на паузе — прогон заведён, но ждёт «Продолжить всё»: решение
    // человека при этом не теряется, оно уже записано в связь.
    if (deps.gate?.defer('stage', input.chatId, options, meta)) return { started: true };
    const started = deps.runs.start(input.chatId, options, meta);
    // Заметка — после старта: до него прогона в реестре нет (см. `start`).
    const notice = started ? groupsActivatedNotice(activated) : undefined;
    if (notice) deps.runs.emitExternal(input.chatId, notice);
    if (started && lost) deps.runs.emitExternal(input.chatId, conversationLostNotice(lost));
    return started ? { started } : { started, ...(wanted ? { busy: true } : {}) };
  };
}
