import type { ChatSummary } from '@agentdeck/contracts';
import type { CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { ChildStageGroup } from '@features/ChatMessages';

/**
 * Сводка «кто на чём работает» для родительского разговора.
 *
 * Разделение развело работу по группам, а конвейер подбора модели добавил
 * каждой группе до трёх разговоров: работа, её проверка на потолке, правки по
 * замечаниям. В списке чатов это девять строк на три группы, и по ним не
 * прочесть главного — на каком звене группа стоит СЕЙЧАС и чем оно ведётся.
 *
 * Поэтому сводка считается по ГРУППАМ, а не по чатам: звенья одной группы живут
 * в одной копии и в одной ветке, ветка их и объединяет. Ветки нет (делили не
 * репозиторий — дети работают в общем каталоге) — группу держит вместе связь
 * через заголовок, под которым её завело разделение.
 *
 * Показывается ПОСЛЕДНЕЕ звено группы: оно и есть её нынешнее состояние, а
 * пройденные подписаны рядом, чтобы был виден путь. Порядок внутри группы — по
 * времени заведения разговора: панель заводит звенья строго друг за другом, и
 * это единственный порядок, в котором они бывают.
 */
export function collectChildStages(
  chats: ChatSummary[],
  parentChatId: string | undefined,
  runs: ActiveRunView[],
): ChildStageGroup[] {
  if (!parentChatId) return [];

  const children = chats.filter((chat) => chat.parentId === parentChatId);
  if (children.length === 0) return [];

  // Ключ группы — ветка; без неё имя группы из связи. Заголовок чата ключом не
  // годится: это текст его первого сообщения, а он у работы, её ревью и правок
  // разный — три звена одной группы разъехались бы по трём строкам.
  const groups = new Map<string, ChatSummary[]>();
  for (const chat of children) {
    const key = chat.branch || chat.groupTitle || chat.id;
    const list = groups.get(key);
    if (list) list.push(chat);
    else groups.set(key, [chat]);
  }

  const view: ChildStageGroup[] = [];
  for (const [key, list] of groups) {
    const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = ordered.at(-1);
    if (!last) continue;

    view.push({
      chatId: last.id,
      // Имя группы приходит из связи (`groupTitle`): заголовок чата — это текст
      // его первого сообщения, а у детей одного разделения он начинается общей
      // преамбулой задания, и по нему группы неотличимы. Связи нет — падаем на
      // заголовок первого звена: он хотя бы принадлежит работе, а не её ревью.
      title: last.groupTitle || ordered[0]?.title || last.title || key,
      ...(last.branch ? { branch: last.branch } : {}),
      stages: ordered.map(stageOf),
      ...(last.model ? { model: last.model } : {}),
      // Ключ прогона сверяется дважды: разговор, заведённый панелью, живёт под
      // временным `new-…`, пока CLI не назовёт настоящий `sessionId`.
      isRunning: runs.some(
        (run) => (run.id === last.id || run.sessionId === last.id) && run.status === 'running',
      ),
    });
  }
  return view;
}

/** Стадия связи; пусто читается как «работа» — так выглядят чаты до конвейера. */
function stageOf(chat: ChatSummary): CascadeStage {
  return chat.stage === 'review' || chat.stage === 'fix' ? chat.stage : 'work';
}
