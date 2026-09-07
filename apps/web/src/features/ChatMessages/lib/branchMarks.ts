import type { ChatMessage } from '@agentdeck/contracts';

/**
 * Где в ленте агент сменил ветку.
 *
 * Claude Code пишет ветку в каждую строку транскрипта, поэтому «когда он ушёл в
 * feat/x» — вопрос к самой переписке, а не к живому git: тот знает только
 * «сейчас» и после перезагрузки страницы рассказать историю не может.
 *
 * Возвращается карта «id сообщения → новая ветка»: отметка ставится ПЕРЕД
 * сообщением, с которого ветка стала другой. Первая известная ветка окна —
 * только точка отсчёта: окно ленты начинается посреди разговора («Загрузить
 * ещё»), и отметка на его первом сообщении означала бы смену, которой не было.
 * Реплики без ветки (черновые пузыри, старые транскрипты) счёт не сбивают.
 */
export function branchMarks(messages: ChatMessage[]): Map<string, string> {
  const marks = new Map<string, string>();
  let current: string | undefined;

  for (const message of messages) {
    const branch = message.gitBranch;
    if (!branch) continue;
    if (current !== undefined && branch !== current) marks.set(message.id, branch);
    current = branch;
  }

  return marks;
}
