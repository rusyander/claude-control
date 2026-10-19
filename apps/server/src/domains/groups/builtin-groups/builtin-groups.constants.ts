import type { BuiltinGroupEntry } from './builtin-groups.types.ts';

/**
 * Каталог встроенных групп доставки (владелец 20.10.2026). Каждая — без
 * участников: выключение группы гасит её участников ГЛОБАЛЬНО, и встроенная с
 * `deep-review` внутри выключила бы человеку его собственный скилл. Профиль
 * едет одним шагом «внутри скилла» — строкой в дописке прогона, без лишнего
 * хода; поэтому текст шага короткий (≤ ~600 знаков, он в каждом ходе).
 *
 * `when` и английский текст шага читает только модель; русские — интерфейс.
 * Ревью везде одно: `deep-review` на задачу, полное и адаптивное — число
 * агентов и кругов решает сам скилл (решение владельца 20.10; разбор
 * `.agent/tmp/delivery-quality-analysis.md`: урезанный вариант терял 30–58 %
 * подтверждённых замечаний).
 */
export const BUILTIN_GROUPS: readonly BuiltinGroupEntry[] = [
  {
    id: 'builtin-delivery',
    name: { ru: 'Задача → MR (быстро)', en: 'Ticket → MR (fast)' },
    description: {
      ru: 'Любая задача трекера до готового MR: каждая проверка один раз, одно глубокое ревью, один полный прогон проверок перед пушем. Профиль выбирается по коду.',
      en: 'Any tracker ticket to a ready MR: every check once, one deep review, one full check run before the push. The profile is picked from the code.',
    },
    when: 'a tracker ticket or task to deliver end to end into an MR when its side (frontend, backend, design) is not yet known',
    skill: 'ticket-delivery',
    step: {
      title: { ru: 'Быстрый путь, профиль по §3', en: 'Fast flow, profile by §3' },
      prompt: {
        ru: 'Быстрый путь: каждая проверка один раз, на глубину уровня риска из §3; одно глубокое ревью ветки (deep-review само решает число агентов и кругов, пропускает его только тривиальная правка T0); полная живая проверка §10 один раз на итоговом коде — и при T0, если менялось поведение: бэкенд — запросы к настоящему эндпоинту, фронт — проход в браузере, обе стороны — интерфейс против настоящего бэкенда, всегда с негативной строкой; один полный прогон проверок перед пушем; MR за один присест; пайплайн не читается; основная догоняется только при конфликте. Профиль §3 — по references/profiles.md. Собственный навык доставки проекта задаёт стадии; этот шаг не убирает ни одной его проверки.',
        en: "Fast flow: every check once, at the depth the §3 tier buys; ONE deep-review of the branch (it sizes its own agents and rounds; only a trivial T0 diff skips it); ONE full §10 live run on the final code — never skipped while behaviour changed: backend = requests to the real endpoint, front = a browser walk, both sides = the UI against the real backend; always with a negative row; one full gate right before the push; MR in one sitting; pipeline not read; main synced only on a real conflict. Pick the §3 profile from references/profiles.md. A project's own delivery skill decides the stages; this step removes none of its gates.",
      },
      gate: {
        ru: 'строка 03-plan называет уровень риска и профиль; строка 10-live — таблица с негативной строкой',
        en: 'the 03-plan row names the tier and the profile; the 10-live row is a table with a negative row',
      },
    },
  },
  {
    id: 'builtin-delivery-strict',
    name: { ru: 'Задача → MR (строго)', en: 'Ticket → MR (strict)' },
    description: {
      ru: 'Тот же путь, но каждая проверка на полную глубину: уровень риска не ниже T2, живая проверка всех входов с вариациями и красным прогоном до правки, mustfail на каждую исправленную ошибку, ревью с холодной перепроверкой каждой находки. Дольше и дороже быстрого — для рискованных задач.',
      en: 'The same path with every check at full depth: tier never below T2, a live run of every entry with variations and a red run before the fix, mustfail per fixed bug, review with a cold re-check of every finding. Slower and costlier than fast — for risky tickets.',
    },
    when: 'a risky ticket delivered into an MR: access, money, data, contracts, migrations, or the human asks for the strict path',
    skill: 'ticket-delivery',
    step: {
      title: {
        ru: 'Строгий путь: T2 и полная живая проверка',
        en: 'Strict flow: T2 and a full live run',
      },
      prompt: {
        ru: 'Строгий путь: уровень риска не ниже T2, даже если risk-tier насчитал меньше (строка 03-plan называет оба). Живая проверка §10 один раз на итоговом коде, по полной: позитив, негатив, граница (значение на шаг за пределом), две вариации (задержка одного запроса, другая роль или пустые данные), проход каждого входа радиуса до шести, красный прогон против кода до правки. mustfail на каждый файл с исправленной ошибкой. deep-review с подсказкой T2 и холодной перепроверкой каждой 🔴/🟡 находки. Остальное — как в быстром пути: проверки один раз, один полный прогон перед пушем, MR за один присест, пайплайн не читается. Профиль §3 — по references/profiles.md.',
        en: 'Strict flow: the tier is never below T2, even when risk-tier computes less (the 03-plan row names both). ONE full §10 live run on the final code: positive, negative, boundary (the value one step past the limit), two variations (one request delayed, another role or empty data), a walk of every radius entry up to six, and a red run against the pre-fix code. mustfail on every bug-fixed file. deep-review with the T2 hint and a cold re-check of every 🔴/🟡 finding. The rest as in the fast flow: checks once, one full gate before the push, MR in one sitting, pipeline not read. Pick the §3 profile from references/profiles.md.',
      },
      gate: {
        ru: '10-live: таблица с негативом, границей, двумя вариациями и пройденными входами; у каждой исправленной ошибки — вердикт mustfail',
        en: '10-live: a table with negative, boundary, two variations and walked entries; every fixed bug carries a mustfail verdict',
      },
    },
  },
  {
    id: 'builtin-delivery-frontend',
    name: { ru: 'Задача → MR: фронт', en: 'Ticket → MR: frontend' },
    description: {
      ru: 'Правки только во фронте: снимки до и после, проход в браузере, глубокое ревью с фронтовой линзой. Шаги бэкенда вырезаны.',
      en: 'Front-only changes: before and after shots, a browser walk, a deep review with the frontend lens. Backend steps are cut.',
    },
    when: 'tickets whose every change is frontend: components, pages, styles, i18n, front tests',
    skill: 'ticket-delivery',
    step: {
      title: { ru: 'Профиль: фронт', en: 'Profile: frontend' },
      prompt: {
        ru: 'Профиль закреплён: фронт — прочитать references/profile-frontend.md до §4, выбор §3 пропустить. Дифф задел серверный файл — перейти на фронт и бэкенд одной строкой журнала. Под собственным навыком доставки проекта эта страница даёт только фронтовую линзу ревью §9 и проход §10.',
        en: "Profile pinned: frontend — read references/profile-frontend.md before §4, skip the §3 pick. The diff reaches a server file → switch to fullstack with one ledger row. Under a project's own delivery skill this page only gives the §9 deep-review its frontend lens and the §10 walk.",
      },
      gate: {
        ru: '03-plan называет профиль «фронт» или строку перехода',
        en: '03-plan says profile: frontend, or the switch row',
      },
    },
  },
  {
    id: 'builtin-delivery-backend',
    name: { ru: 'Задача → MR: бэкенд', en: 'Ticket → MR: backend' },
    description: {
      ru: 'Без видимых правок: эндпоинт проверяется запросами, глубокое ревью с бэкенд-линзой, база только на чтение. Снимков и браузера нет.',
      en: 'No visible change: the endpoint is checked by requests, a deep review with the backend lens, the database read-only. No shots, no browser.',
    },
    when: 'tickets with no user-visible file: handlers, services, queries, workers, jobs',
    skill: 'ticket-delivery',
    step: {
      title: { ru: 'Профиль: бэкенд', en: 'Profile: backend' },
      prompt: {
        ru: 'Профиль закреплён: бэкенд — прочитать references/profile-backend.md до §4, выбор §3 пропустить. Сначала вопрос §1 о бэкенде; база — только SELECT/EXPLAIN/схема. Ревью §9 получает бэкенд-линзу. Видимая на экране правка — переход на фронт и бэкенд одной строкой журнала.',
        en: 'Profile pinned: backend — read references/profile-backend.md before §4, skip the §3 pick. Ask the §1 backend question first; the DB stays SELECT/EXPLAIN/schema. The §9 deep-review gets the backend lens. A screen-visible change → fullstack, one ledger row.',
      },
      gate: {
        ru: '03-plan называет профиль «бэкенд», ответ на вопрос §1 — в журнале',
        en: '03-plan says profile: backend and the §1 backend answer is in the ledger',
      },
    },
  },
  {
    id: 'builtin-delivery-design',
    name: { ru: 'Экраны по макету Figma', en: 'Screens from a Figma mock' },
    description: {
      ru: 'Страница за страницей по макету: один проверяющий сверяет числа, MR с парами до и после и шагами для QA.',
      en: 'Page by page from the mock: one checker compares the numbers, an MR with before and after pairs and QA steps.',
    },
    when: 'build or match screens from a Figma mock one to one; the task carries a Figma link or node',
    skill: 'ticket-delivery',
    step: {
      title: { ru: 'Профиль: дизайн', en: 'Profile: design' },
      prompt: {
        ru: 'Профиль закреплён: дизайн — прочитать references/profile-design.md до §4; сверка через figma-parity, один проверяющий на весь прогон, MR — через mr-visual-report. Файл с поведением — глубокое ревью §9 по этим файлам. Figma MCP не подключён — сказать и остановиться.',
        en: 'Profile pinned: design — read references/profile-design.md before §4; parity through figma-parity, one checker for the whole run, the MR through mr-visual-report. A behaviour-bearing file → the §9 deep-review over those files. Figma MCP not attached → say so and stop.',
      },
      gate: {
        ru: 'у каждой страницы .agent/parity/<page>.md без открытых пунктов',
        en: 'every page has .agent/parity/<page>.md with 0 open',
      },
    },
  },
  {
    id: 'builtin-delivery-fullstack',
    name: { ru: 'Задача → MR: фронт и бэкенд', en: 'Ticket → MR: frontend and backend' },
    description: {
      ru: 'Обе стороны или общий контракт: сначала контракт, потом сервер, потом клиент против настоящего бэкенда; глубокое ревью с обеими линзами.',
      en: 'Both sides or a shared contract: contract first, then server, then the client against the real backend; a deep review with both lenses.',
    },
    when: 'tickets changing both server and client, or an API contract or shared type both sides read',
    skill: 'ticket-delivery',
    step: {
      title: { ru: 'Профиль: фронт и бэкенд', en: 'Profile: fullstack' },
      prompt: {
        ru: 'Профиль закреплён: фронт и бэкенд — прочитать references/profile-fullstack.md до §4. Порядок: контракт → сервер → клиент; заглушек по обе стороны шва нет; вопрос §1 о бэкенде — сейчас. Ревью §9 получает обе линзы и сверяет обе стороны каждого изменённого эндпоинта.',
        en: 'Profile pinned: fullstack — read references/profile-fullstack.md before §4. Order: contract → server → client; no stub on either side of the seam; ask the §1 backend question now. The §9 deep-review gets both lenses and owns parity both ways.',
      },
      gate: {
        ru: '03-plan называет профиль «фронт и бэкенд» и изменение контракта или «контракт не меняется»',
        en: "03-plan says profile: fullstack and names the contract change or 'no contract change'",
      },
    },
  },
  {
    id: 'builtin-mr-followup',
    name: { ru: 'Замечания к MR', en: 'MR review comments' },
    description: {
      ru: 'Треды ревьюера в уже открытом MR: правка или аргументированный ответ на каждый; ответы публикуются после вашего «да».',
      en: 'Reviewer threads on an open MR: a fix or a reasoned reply to each; replies are posted after your yes.',
    },
    when: 'reviewer threads on an existing MR: fix the review comments, answer the threads',
    skill: 'ticket-delivery',
    step: {
      title: { ru: 'Режим: замечания к MR', en: 'Mode: MR follow-up' },
      prompt: {
        ru: 'Режим замечаний к MR из references/profiles.md: своя ветка MR, один запрос обсуждений, по каждому треду — согласен → правка, не согласен → ответ с file:line; проверки затронутых пакетов; ответы — черновиком в журнал, публикуются после «да» человека на всю пачку.',
        en: "Run the MR follow-up mode of references/profiles.md: the MR's own branch, one discussions call, per thread agree → fix or disagree → reasoned answer with file:line; touched packages' checks; replies drafted into the ledger and posted after the user's yes for the batch.",
      },
      gate: {
        ru: 'у каждого открытого треда — правка с file:line или черновик ответа',
        en: 'every unresolved thread has a fix with file:line or a drafted reasoned reply',
      },
    },
  },
  {
    id: 'builtin-mr-review',
    name: { ru: 'Ревью чужого MR', en: "Review someone's MR" },
    description: {
      ru: 'Только чтение: полное адаптивное ревью, находки с доказательством, отчёт в .agent/reviews/, комментарии в MR — только по просьбе.',
      en: 'Read-only: a full adaptive review, findings with proof, a report in .agent/reviews/, MR comments only on request.',
    },
    when: 'review someone else’s MR or PR by link; findings only, no fixes in their branch',
    skill: 'deep-review',
    step: {
      title: { ru: 'Чужой MR: только чтение', en: "Someone's MR: read-only" },
      prompt: {
        ru: 'Чужой MR: только чтение. Ни правок, ни коммитов, ни пушей, ни сообщений в их MR. Ревью полное и адаптивное: дорожки, число агентов и круги скилл решает сам (lane-high); каждая находка доказана прогоном или file:line; отчёт — в .agent/reviews/; комментарии в MR — только по просьбе человека, каждая запись объявлена и одобрена.',
        en: "Someone else's MR: read-only. No edits, commits, pushes or posts in their MR. Full adaptive review: the skill plans its own lanes, agent count and rounds (lane-high); each finding proved by a run or file:line; the report into .agent/reviews/; inline comments only when the user asks, each write announced and approved.",
      },
      gate: {
        ru: 'отчёт в .agent/reviews/ называет поднято · подтверждено · отклонено',
        en: 'the report in .agent/reviews/ carries raised · confirmed · rejected',
      },
    },
  },
];
