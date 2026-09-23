import type { SplitGroupStatusView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { gitSync } from '../project-git/exec.ts';

/**
 * Ворота ветки: первая правка в ОСНОВНОЙ рабочей копии не проходит молча.
 *
 * Зачем они вообще. Чат привязан к каталогу, а не к ветке, и каталог у git один
 * на всех: два чата в одном проекте — это два агента в одной рабочей копии и с
 * одним HEAD. Пока оба читают, всё честно; первая же правка делает их зависимыми
 * друг от друга, а `checkout -b` из одного чата уводит ветку у второго прямо
 * из-под рук. Поэтому перед первой правкой панель останавливается и предлагает
 * завести копию (`git worktree`) с собственной веткой: основной каталог остаётся
 * витриной на main, а чатов в проекте может быть сколько угодно.
 *
 * Почему ворота стоят на ПРОВОДЕ, а не в промпте. Просьба «сперва заведи ветку»
 * исполняется настроением модели и проверить её нечем; здесь же вызов физически
 * придержан брокером прав, и мимо него не пройдёт ни свой CLI, ни чужой.
 *
 * ГДЕ ДЫРА, и она названа честно: ворота ловят вызов ИНСТРУМЕНТА правки. Агент,
 * который пишет файл оболочкой (`sed -i`, перенаправление в файл, `git apply`),
 * проходит мимо — такие команды ловятся отдельным разбором ниже, но полным он не
 * бывает. Ворота — это умолчание для честного агента, а не песочница против
 * враждебного.
 */

/**
 * Инструменты правки — свои и чужих CLI. Шире, чем набор в `auto-approve.ts` и
 * `ChatRunRegistry.ts` (там речь о правках Claude Code), намеренно: ворота
 * стоят на общем проводе, и чужой агент, зовущий `write_file`, обязан
 * остановиться ровно так же, как свой с `Edit`.
 */
const EDIT_TOOL_NAMES = new Set(
  [
    // Claude Code
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    // codex, aider и совместимые
    'apply_patch',
    'edit_file',
    'create_file',
    'str_replace_editor',
    'str_replace_based_edit_tool',
    // qwen, gemini
    'write_file',
    'replace',
    'edit',
  ].map((name) => name.toLowerCase()),
);

/**
 * Запись в файл ОБОЛОЧКОЙ. Список короткий и намеренно грубый: он закрывает
 * обычные способы записать файл командой, а не изображает разбор языка оболочки.
 * Ложное срабатывание здесь стоит одной карточки, пропуск — правки в общей
 * копии, поэтому сомнение решается в пользу карточки.
 */
const SHELL_WRITE = [
  />{1,2}\s*[^\s|&;]+/, // перенаправление в файл
  /(^|[\s|(])tee\b/i,
  /(^|[\s|(])sed\b[^\n|;]*\s-i\b/i,
  /(^|[\s|(])(patch|dd)\b/i,
  /\bgit\s+(apply|am)\b/i,
  /(^|[\s|(])(cp|mv|install)\b/i,
  /(^|[\s|(])(Set-Content|Add-Content|Out-File)\b/i,
];

/** Инструменты оболочки — свои и чужие: у них смотрим на саму команду. */
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'run_shell_command', 'execute_command', 'run']);

/** Команда из ввода инструмента оболочки, в каком бы поле она ни лежала. */
function commandOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const field of ['command', 'cmd', 'script', 'input']) {
    const value = record[field];
    if (typeof value === 'string') return value;
    // qwen отдаёт команду массивом argv — склеиваем, разбор всё равно грубый.
    if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ');
  }
  return '';
}

/** Правит ли этот вызов файлы в рабочей копии. */
export function isWritingCall(toolName: string, input: unknown): boolean {
  const name = toolName.toLowerCase();
  if (EDIT_TOOL_NAMES.has(name)) return true;
  if (!SHELL_TOOL_NAMES.has(name)) return false;
  const command = commandOf(input);
  return command.length > 0 && SHELL_WRITE.some((pattern) => pattern.test(command));
}

/**
 * ОСНОВНАЯ ли это рабочая копия репозитория.
 *
 * Признак берётся у самого git, а не из имени каталога: у копии (`git worktree`)
 * собственный `--git-dir` и общий `--git-common-dir`, у основной копии они
 * совпадают. Имя каталога соврало бы — копию мог завести человек руками и
 * положить куда угодно, а ворота обязаны молчать ВНУТРИ копии: там ветка уже
 * своя, и предлагать завести ещё одну поверх неё незачем.
 *
 * Не репозиторий (песочница панели, каталог без `.git`) — тоже «не основная
 * копия»: делить там нечего, и карточка была бы шумом.
 */
export function isMainWorkingCopy(cwd: string): boolean {
  const gitDir = gitSync(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return false;
  const common = gitSync(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return false;
  return normalize(gitDir) === normalize(common);
}

function normalize(path: string): string {
  return path.trim().split('\\').join('/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Отказ придержанному вызову, когда работа переезжает в копию. Он уезжает
 * агенту результатом инструмента и в транскрипт, поэтому говорит не «нельзя», а
 * куда именно переехала работа: следующий ход агент делает уже там.
 */
export function branchMovedDenial(path: string, branch: string): string {
  return `Правка в основной копии не применена: работа переезжает в ${path} на ветку ${branch}. Прогон поднимается в этом каталоге и продолжает ту же задачу — повтори правку там.`;
}

/**
 * Задание перезапущенному прогону. Копия — не новая задача, поэтому фраза
 * короткая и без пересказа: история разговора при `--resume` никуда не делась.
 */
export function branchContinuePrompt(path: string, branch: string): string {
  return `Рабочий каталог сменился: ты в копии ${path} на ветке ${branch}, основной каталог проекта остаётся нетронутым. Продолжай ту же задачу здесь и начни с правки, которая не прошла.`;
}

/** Группа разделения глазами ворот: кому отдана работа и как к ней обратиться. */
export interface BranchGateChild {
  /** Номер группы с единицы — тот, что пишется в блоке `agentdeck:tell N`. */
  number: number;
  title: string;
  branch: string;
  status: SplitGroupStatusView;
  chatId?: string;
}

/**
 * Что воротам известно о разговоре, чья работа отдана группам (Д15). Без этого
 * родитель, у которого дети уже чинят тот же MR, получал обычную карточку, и
 * «завести копию» уносило его в третью копию от `main` — мимо детей и мимо MR.
 */
export interface BranchGateContext {
  children: BranchGateChild[];
  /**
   * От чего отводить копию родителя: ветка MR, на которой работают дети. Есть,
   * только когда она у детей одна, — из двух разных MR выбирать наугад нельзя.
   */
  base?: string;
}

/** Ветка MR ребёнка по его связи — то, что панель узнала у git/форджа (Д2, Д9). */
export interface ChildReviewBranch {
  branch?: string;
  remote?: string;
}

export function branchGateContext(
  split: SplitPlanView | undefined,
  reviewOf: (chatId: string) => ChildReviewBranch | undefined,
): BranchGateContext | undefined {
  if (!split || split.groups.length === 0) return undefined;
  const children = split.groups.map((group) => ({
    number: group.index + 1,
    title: group.title,
    branch: group.branch,
    status: group.status,
    ...(group.chatId ? { chatId: group.chatId } : {}),
  }));
  // Удалённая ветка, а не локальная: копия MR часто стоит в detached HEAD, и
  // локальной ветки с этим именем может не быть вовсе (Д2).
  const bases = new Set(
    split.groups
      .map((group) => (group.chatId ? reviewOf(group.chatId) : undefined))
      .filter((review): review is ChildReviewBranch & { branch: string } => Boolean(review?.branch))
      .map((review) => (review.remote ? `${review.remote}/${review.branch}` : review.branch)),
  );
  const [base] = bases;
  return { children, ...(bases.size === 1 && base ? { base } : {}) };
}

/**
 * Отказ правке родителя, когда работа отдана группам: не «нельзя», а куда её
 * нести. Агент уже умеет писать ребёнку (Д7), и человеку остаётся одно нажатие
 * вместо третьей копии на ту же задачу.
 */
export function branchGateHandedDenial(children: readonly BranchGateChild[]): string {
  const list = children.map(
    (child) => `${child.number} — «${child.title}» (ветка ${child.branch})`,
  );
  return `Правка не применена: работа этого разговора отдана группам разделения, и правит код группа, а не ты. Группы: ${list.join('; ')}. Передай правку нужной группе блоком \`\`\`agentdeck:tell N с текстом поручения — панель доставит его в чат группы.`;
}

/** Отказ, когда человек не разрешил правку вовсе. */
export const BRANCH_GATE_STOPPED =
  'Правка отклонена: работать в основной рабочей копии проекта не разрешено.';

/**
 * Кириллица в имени ветки допустима для самого git, но дальше её ждут чужие
 * руки: адрес MR, имя каталога копии, чужой CI. Поэтому название разговора
 * переводится в латиницу, а не выбрасывается: `agent/perenos-sredy-a1b2c3`
 * человеку говорит всё, `agent/chat-a1b2c3` — ничего.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Имя ветки по названию разговора. Человек его правит в карточке — здесь нужно
 * лишь годное умолчание, которое переживёт `git check-ref-format`.
 */
export function suggestBranchName(title: string | undefined, chatId: string): string {
  const slug = [...(title ?? '').toLowerCase()]
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  // Хвост из ключа разговора — не украшение: два чата с одинаковым названием
  // («правки по ревью») иначе спорили бы за одно имя ветки, и второй получал бы
  // отказ git вместо копии.
  const tail = chatId.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'chat';
  return slug ? `agent/${slug}-${tail}` : `agent/chat-${tail}`;
}
