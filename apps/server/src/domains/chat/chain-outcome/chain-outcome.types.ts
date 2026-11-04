import type {
  SplitHumanStepProposal,
  SplitTicketProposal,
} from '@agentdeck/contracts/split-tickets';
import type { LearnedSieveRow, SieveReportRow } from '@agentdeck/contracts/sieves';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { HumanAskKind } from '../split-continue.ts';

/**
 * Что конец хода значит для группы (Д3). Тип жил в конвейере разделения; конвейер ушёл
 * вместе со старым рантаймом групп (этап 10, F5), а итог хода ещё читают планировщик
 * продолжений и цепочка чужого CLI — пока их прогоны идут через реестр панели.
 */
export interface ChainOutcome {
  status: 'done' | 'failed' | 'awaiting' | 'background';
  waitingFor?: SplitPlanRecord['groups'][number]['waitingFor'];
  /** Хвост ответа — строке группы в хабе (Д16). */
  tail?: string;
  /**
   * Строки `HUMAN:` из ПОЛНОГО текста хода (`humanAsksOf`), не из хвоста: хвост
   * обрезан до 280 знаков спереди и терял метку длинной строки.
   */
  humanAsks?: { kind: HumanAskKind; what: string }[];
  /** Ссылка на MR, названная в ответе (доставка группы). */
  mr?: string;
  /** Что сделано по фактам копии (Д5). */
  result?: SplitPlanRecord['groups'][number]['result'];
  error?: string;
  /** Сколько раз надзор уже повторил упавший ход группы (Д10). */
  retries?: number;
  /** Ход упёрся в лимит подписки: до какого момента ждать сброса (ISO, журнал 89). */
  limitUntil?: string;
  /**
   * Лимит на исходе (`allowed_warning`, аудит 25.09, L63): ход прошёл, но
   * новых групп до сброса (ISO) заводить нельзя.
   */
  limitWarningUntil?: string;
  /** Ход ревью кончил цепочку: замечаний в вердикте; нет — вердикта не было. */
  reviewFindings?: number;
  /** Блоки тикетов из текста хода — дефекты вне задач группы (95b). */
  tickets?: SplitTicketProposal[];
  /** Шаги, которые группа сделать не может, а человек может (находка 112). */
  humanSteps?: SplitHumanStepProposal[];
  /** Строки отчёта о ситах из текста хода. */
  sieveRows?: SieveReportRow[];
  /** Сита, выученные группой по тредам её MR, — ещё не проверенные. */
  learnedSieves?: LearnedSieveRow[];
  /** MCP-серверы вне профиля, которые группа попросила блоком `mcp` (1.2). */
  mcpRequests?: string[];
}
