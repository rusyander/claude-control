import type { PlatformGatewayEvent, PlatformToolShimReport } from '@agentdeck/contracts';

/**
 * Прослойка инструментов — СВОДКА по следу запросов (Т5.5).
 *
 * Отвечает на один вопрос человека: «агент через контур вообще что-нибудь
 * делает руками?» Через контур ответ на него неочевиден — инструменты едут
 * текстом, и ход, в котором модель написала «файл создан», выглядит удачным.
 * Поэтому рядом со счётом состоявшихся вызовов стоит счёт ходов, в которых
 * модель описала действие и не вызвала ничего: без него человек ищет поломку в
 * панели, а поломки нет — модель не послушалась протокола.
 *
 * Ни текста ответа, ни аргументов вызова здесь нет: в след они не попадают.
 */

export interface ToolShimReportOptions {
  /** Считать только по этим контурам — как и сводка проверок. */
  platformIds?: string[];
}

export function toolShimReport(
  events: PlatformGatewayEvent[],
  options: ToolShimReportOptions = {},
): PlatformToolShimReport {
  const flaws = new Map<string, number>();
  let requests = 0;
  let turns = 0;
  let calls = 0;
  let claimed = 0;
  let since: string | undefined;

  for (const event of events) {
    if (options.platformIds && !options.platformIds.includes(event.platformId)) continue;
    // Прослойка работала ровно там, где клиент объявил инструменты. Остальные
    // запросы в знаменателе только мешают: обычный чат инструментов и не звал.
    if (event.shimmed.length === 0) continue;

    requests += 1;
    if (!since || (event.at && event.at < since)) since = event.at || since;
    if (event.toolCalls > 0) turns += 1;
    calls += event.toolCalls;
    if (event.claimedWithoutCall) claimed += 1;
    for (const reason of event.toolFlaws) flaws.set(reason, (flaws.get(reason) ?? 0) + 1);
  }

  return {
    requests,
    turns,
    calls,
    claimed,
    flaws: [...flaws.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    ...(since ? { since } : {}),
  };
}
