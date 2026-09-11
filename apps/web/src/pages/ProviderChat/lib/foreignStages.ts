import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { CASCADE_STAGES, type CascadeStage } from '@agentdeck/contracts/model-cascade';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { mergeSplitGroups, type ChildStageGroup } from '@features/ChatMessages';

/**
 * Хаб родителя у чужого CLI: те же строки групп, что у Claude, но собранные из
 * ДЕРЕВА, а не из списка чатов и прогонов.
 *
 * У Claude сводку считает `pages/Chat/lib/childStages.ts` по списку разговоров:
 * там у каждого чата есть и связь (`parentId`, `groupTitle`, ветка), и живой
 * прогон в сторе. У чужого провайдера нет ни того, ни другого — разговоры
 * ведёт хранилище панели, прогон одноразовый, — зато есть дерево с сервера, и в
 * его узлах лежит ровно то, что нужно строке: название группы, ветка, звено и
 * идёт ли оно. Второй копии счёта здесь нет: это другой ИСТОЧНИК, а не другая
 * логика.
 *
 * Ключ узла именованный (`codex:c1a2…`) — открывать по нему нечего: страница
 * чужого чата знает разговоры по их собственным идентификаторам. Поэтому наружу
 * уходит разобранный ключ.
 *
 * Уровни (Т3) добавляют то, чего в дереве нет вовсе: группы, у которых чата ЕЩЁ
 * НЕТ — они ждут разбора, предшественников или ответа человека. Их строки идут
 * из записи конвейера (`tree.split`) той же склейкой, что у Claude.
 */
export function collectForeignStages(tree: ChatTreeView | undefined): ChildStageGroup[] {
  if (!tree) return [];

  // Ключ группы — ветка: звенья одной группы живут в одной копии и в одной
  // ветке. Ветки нет (делили не репозиторий) — держит название группы.
  const groups = new Map<string, ChatTreeView['nodes']>();
  for (const node of tree.nodes) {
    const key = node.branch || node.title || node.chatId;
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }

  const byKey = new Map<string, ChildStageGroup>();
  for (const [key, nodes] of groups) {
    const last = nodes.at(-1);
    if (!last) continue;
    byKey.set(key, {
      // Пустой `chatId` строка терпит (у Claude так выглядит группа, которой
      // конвейер ещё не завёл чата), и открывать её тогда нечего.
      chatId: parseForeignChatKey(last.chatId)?.chatId ?? '',
      title: last.title || nodes[0]?.title || key,
      ...(last.branch ? { branch: last.branch } : {}),
      stages: nodes.map(stageOf),
      isRunning: nodes.some((node) => node.running),
      ...(tree.paused ? { isPaused: true } : {}),
    });
  }
  return tree.split ? mergeSplitGroups(byKey, tree.split) : [...byKey.values()];
}

/** Звено узла; незнакомое или пустое читается как работа — так же, как у Claude. */
function stageOf(node: ChatTreeView['nodes'][number]): CascadeStage {
  const stage = CASCADE_STAGES.find((known) => known === node.stage);
  return stage ?? 'work';
}
