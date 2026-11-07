import { BG_KINDS, type AgentNode } from '@agentdeck/contracts/core/agents';
import type { AgentFilters, CoreTreeNode, NodeLook } from './coreAgents.types';

/**
 * Агенты разговора по журналу ядра (этап 11, W3-17): узлы приходят плоским списком всех задач чата
 * (`GET /api/core/agents?conversationId=`), дерево и подписи строятся здесь. Расход `null` —
 * «неизвестно», никогда не ноль.
 */

/** Без фильтров — общий запрос кнопки, окна и боковой панели: один кэш, одно перечитывание. */
export const NO_FILTERS: AgentFilters = Object.freeze({});

const keyOf = (node: Pick<AgentNode, 'taskId' | 'nodeId'>): string =>
  `${node.taskId}\u0000${node.nodeId}`;

/** Фоновая работа (команда, наблюдение, сервер…) — у неё своя подробность: вывод, владелец, итог. */
export function isBgItem(node: Pick<AgentNode, 'kind'>): boolean {
  return (BG_KINDS as readonly string[]).includes(node.kind);
}

/**
 * Число на карточке «фоном: N»: всё, что идёт в фоне сейчас, — фоновые работы и фоновые
 * субагенты. Законченное в счёт не идёт.
 */
export function runningBackground(nodes: readonly AgentNode[]): number {
  return nodes.filter((node) => node.background && node.status === 'running').length;
}

/**
 * Агенты карточки группы: всё, кроме сеансов единиц (субагенты и фоновые работы), — идущие первыми,
 * дальше новыми первыми; с числами «идёт · закончено».
 */
export function workerNodes(nodes: readonly AgentNode[]): {
  rows: AgentNode[];
  running: number;
  finished: number;
} {
  const rows = nodes
    .filter((node) => node.kind !== 'unit-session')
    .sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        b.startedAt - a.startedAt,
    );
  const running = rows.filter((node) => node.status === 'running').length;
  return { rows, running, finished: rows.length - running };
}

/** Задачи ядра этого чата — по ним идут поток и выгрузка; порядок — как в списке (новые первыми). */
export function taskIdsOf(nodes: readonly AgentNode[]): string[] {
  return [...new Set(nodes.map((node) => node.taskId))];
}

/** Задачи, в которых ещё кто-то идёт: на их поток стоит подписаться. */
export function liveTaskIds(nodes: readonly AgentNode[]): string[] {
  return taskIdsOf(nodes.filter((node) => node.status === 'running'));
}

/**
 * Дерево из плоского списка: родитель ищется в той же задаче; не найден (отфильтрован или
 * за пределом ответа) — узел становится корнем, а не пропадает. Корни — новыми первыми (как
 * пришли), вложенные — по порядку запуска.
 */
export function buildCoreTree(nodes: readonly AgentNode[]): CoreTreeNode[] {
  const byKey = new Map<string, CoreTreeNode>();
  for (const node of nodes) byKey.set(keyOf(node), { node, level: 0, children: [] });
  const roots: CoreTreeNode[] = [];
  for (const entry of byKey.values()) {
    const parent =
      entry.node.parentId === null
        ? undefined
        : byKey.get(keyOf({ taskId: entry.node.taskId, nodeId: entry.node.parentId }));
    if (parent && parent !== entry) parent.children.push(entry);
    else roots.push(entry);
  }
  const settle = (entry: CoreTreeNode, level: number): void => {
    entry.level = level;
    entry.children.sort((a, b) => a.node.startedAt - b.node.startedAt);
    for (const child of entry.children) settle(child, level + 1);
  };
  for (const root of roots) settle(root, 0);
  return roots;
}

/** Владелец узла в списке чата: тот, кто его запустил (сеанс или субагент той же задачи). */
export function ownerOf(
  nodes: readonly AgentNode[],
  node: Pick<AgentNode, 'taskId' | 'parentId'>,
): AgentNode | undefined {
  if (node.parentId === null) return undefined;
  return nodes.find((n) => n.taskId === node.taskId && n.nodeId === node.parentId);
}

/**
 * Где искать владельца выбранного узла: узлы чата плюс показанные фильтром. Под фильтром группы
 * в списке стоят задачи других чатов группы — их владельцев в узлах чата нет, и подробность
 * узла теряла «осиротел — потерян» (ревью волны 3). Статус и модель фильтра тоже режут показанное,
 * поэтому одних показанных мало — нужны оба набора.
 */
export function ownerPool(
  chatNodes: readonly AgentNode[],
  shown: readonly AgentNode[] | undefined,
): readonly AgentNode[] {
  if (!shown || shown.length === 0) return chatNodes;
  const known = new Set(chatNodes.map((n) => `${n.taskId}:${n.nodeId}`));
  const extra = shown.filter((n) => !known.has(`${n.taskId}:${n.nodeId}`));
  return extra.length === 0 ? chatNodes : [...chatNodes, ...extra];
}

/** Найти узел чата по его id (боковая панель знает только чат и узел, задачу — список). */
export function findNode(nodes: readonly AgentNode[], nodeId: string): AgentNode | undefined {
  return nodes.find((node) => node.nodeId === nodeId);
}

/**
 * Что показать человеку: снесённая уборкой или ещё живая сирота — «осиротел», молчащая фоновая
 * работа — «висит»; иначе — состояние ядра как есть. Потерянная фоновая работа, чей владелец сам
 * кончился аварийно (`lost`/`failed`/`killed`), — «осиротел — потерян»: владелец ушёл, а судьба
 * команды неизвестна. Так выглядит снятый хост сессий (живой прогон 06.11): ядро закрывает работу
 * `bg.ended lost` без сигнала, если CLI не назвал номер процесса, — снимать было нечего.
 */
export function nodeLook(
  node: Pick<AgentNode, 'kind' | 'status' | 'signals'>,
  owner?: Pick<AgentNode, 'status'>,
): NodeLook {
  if (node.status === 'reaped') return 'reaped';
  if (
    node.status === 'lost' &&
    (node.signals.includes('bg-orphan') ||
      (isBgItem(node) && owner !== undefined && OWNER_GONE.has(owner.status)))
  )
    return 'orphanLost';
  if (node.status === 'running' && node.signals.includes('bg-orphan')) return 'orphaned';
  if (node.status === 'running' && node.signals.includes('bg-hang')) return 'hanging';
  return node.status;
}

/** Аварийный конец владельца: его фоновая работа осталась без хозяина. */
const OWNER_GONE: ReadonlySet<AgentNode['status']> = new Set(['lost', 'failed', 'killed']);

export type LookTone = 'danger' | 'success' | 'warning' | 'neutral';

export const LOOK_TONE: Record<NodeLook, LookTone> = {
  running: 'warning',
  completed: 'success',
  failed: 'danger',
  killed: 'neutral',
  stopped: 'neutral',
  reaped: 'danger',
  lost: 'danger',
  orphaned: 'danger',
  orphanLost: 'danger',
  hanging: 'danger',
};

/** Ключ словаря и значения для строки состояния: законченная фоновая работа — с кодом выхода. */
export function lookText(
  node: Pick<AgentNode, 'kind' | 'status' | 'signals' | 'exitCode'>,
  owner?: Pick<AgentNode, 'status'>,
): {
  key: string;
  values?: Record<string, number>;
} {
  const look = nodeLook(node, owner);
  if (look === 'completed' && node.exitCode !== undefined)
    return { key: 'agentTree.status.completedCode', values: { code: node.exitCode } };
  return { key: `agentTree.status.${look}` };
}

/** Сколько шёл узел: законченный — до конца, идущий — до `now`. */
export function nodeDurationMs(
  node: Pick<AgentNode, 'startedAt' | 'endedAt'>,
  now: number,
): number {
  return Math.max(0, (node.endedAt ?? now) - node.startedAt);
}

/** Модели, встреченные в узлах, — варианты фильтра «Модель». */
export function modelsOf(nodes: readonly AgentNode[]): string[] {
  const models = new Set<string>();
  for (const node of nodes) if (node.model) models.add(node.model);
  return [...models].sort();
}

/**
 * Строка запроса списка: чат — `conversationId`; выбрана группа — охват вся группа (`groupId`)
 * вместо чата. Пустые фильтры не посылаются: ядро судит каждый ключ, пустой — 400.
 */
export function agentsQuery(chatId: string, filters: AgentFilters): Record<string, string> {
  const query: Record<string, string> = filters.groupId
    ? { groupId: filters.groupId }
    : { conversationId: chatId };
  if (filters.status) query.status = filters.status;
  if (filters.model) query.model = filters.model;
  if (filters.kind) query.kind = filters.kind;
  if (filters.class) query.class = filters.class;
  return query;
}
