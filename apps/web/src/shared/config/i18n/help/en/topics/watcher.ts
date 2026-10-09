import type { watcherRu } from '../../ru/topics/watcher';

/** English help for the “Watcher” section; typed against the Russian module. */
export const watcherEn: typeof watcherRu = {
  topic: {
    title: 'Watcher',
    summary:
      'A background agent: collects the panel’s problems, checks them against the code and writes a report; a bug can be described in words',
    lead:
      'While the watcher runs, the panel records all of its own problems, checks each one ' +
      'against its source code and adds remarks — all that is left is to send the report to a ' +
      'person or hand it to another agent. A bug found by hand is described in words: it goes ' +
      'into the report only if the model confirms it in the code.',

    guideTitle: 'What this document covers',
    guideText:
      'First a diagram — the path of one problem. Then steps in frames: starting it, the ' +
      'sidebar row, a bug in words, the report. After that — what goes into the report, how ' +
      'to read it, what runs the analysis and what happens when the watcher cannot work.',

    stepsTitle: 'Start it and use it',
    stepsCaption:
      'The “Watcher” page — the row with an eye in the sidebar, always visible. Here the ' +
      'watcher is started and stopped, bugs are described and the report is read.',
    on: 'Start it',
    onText:
      'The “Watcher · off” row in the sidebar leads to the page; “Start the watcher” is the ' +
      'only button that turns it on. Turned off, it collects nothing and spends no tokens. ' +
      'Running, it survives a panel restart, and running time and spend start from zero ' +
      'every time it is started.',
    control: 'The summary on the page',
    controlText:
      'While running, the card shows running time, spend, the number of analyses and report ' +
      'sections, and the button turns into “Stop”. When it cannot work, ' +
      'the reason is spelled out right there.',
    indicator: 'A row on every page',
    indicatorText:
      'While the watcher runs, the “Watcher” row shows its running time and a dot that ' +
      'pulses while an analysis is under way; the tooltip reads “The agent is running in the ' +
      'background and collecting information”, plus time and spend. A click opens a window: ' +
      'summary, “Turn off”, “Open page” and the “Found a bug yourself?” form with the last ' +
      'three checks. Escape or a click outside the window closes it, and focus returns to the ' +
      'row.',
    bug: 'Describe a bug in words',
    bugText:
      'In the row’s window or on the page, describe what broke and where, then press ' +
      '“Check” (or Ctrl+Enter). From the window the address of the open page goes along with ' +
      'the text; from the watcher page it does not — the text names the place. The watcher’s ' +
      'model checks the description against the panel code with the same read-only tools: ' +
      'confirmed — a WR-n section appears in the report with the source “human”; not ' +
      'confirmed or undecided — nothing is written to the report. The outcome shows under ' +
      'the form in “Your checks”: checking, confirmed with the section number, not confirmed ' +
      'by the code (with the model’s reason), the model could not decide, the check failed — ' +
      'then the entry goes out with the next analysis. A watcher that is off accepts no ' +
      'descriptions: the page shows a hint instead of the form.',
    page: 'The report on the page',
    pageText:
      'Further down the same page sits the report: the file path and when it last changed, ' +
      'the filters “All”, “Failures”, “Remarks”, “Confirmed” with section counts, and a card ' +
      'per section — number, title, status, severity, kind, repeats, place in the code, ' +
      'first and last time. “Details” expands the section body — the same text as in the ' +
      'file. The report stays visible while the watcher is stopped; the page re-reads it ' +
      'every ten seconds on its own.',

    report: 'What goes into the report',
    reportText:
      'Server: 5xx responses; 4xx responses that mean a bug in its own interface (400 and ' +
      '422 — the body failed the schema, 404 on a path with no route, a 409 repeated three ' +
      'times within a minute); log errors and warnings; responses slower than the ' +
      'threshold (except streams — a chat, panel-agent or sandbox turn is long by nature); ' +
      'failed CLI launches and CLI runs that exited with an error, with the tail ' +
      'of their stderr (provider errors arrive this way too, and the line naming the ' +
      'cause sits right in the message). Page: errors and rejected promises, render crashes, ' +
      'console errors and warnings (React ones included), requests the server never saw ' +
      '(a network drop, or a 5xx the proxy or Vite answered while the server restarted), ' +
      'wrongly shaped replies (HTML instead of JSON), loading slower than ' +
      'the threshold. Other 4xx are refusals on the merits, not failures. On top of that ' +
      'the model writes remarks — defects it notices in the code nearby. One cause — one ' +
      'section: a refusal reported by both the server and the page counts in one section, ' +
      'and the model may merge a section it proves has the same cause. The watcher’s own ' +
      'CLI runs never land in the report: a failed analysis is a problem on the card, not ' +
      'a new section. A page under automation (the panel’s Playwright checks) does not ' +
      'send request failures the server never saw: those are responses the check stubbed ' +
      'and tabs it closed; its page and console errors are still sent.',
    read: 'How to read the report',
    readText:
      'WATCH-REPORT.md in the app root — the page shows the path above the report. On top sits an index ' +
      'table: number WR-n, kind (failure or remark), severity, status, repeats, place, ' +
      'gist. A section appears at once as “checking”; after analysis it gets a status ' +
      '(confirmed in code, no cause in code, unclear), file and line, root cause, steps to ' +
      'reproduce, how to fix, the evidence as it was (for a CLI — the last stderr lines) and ' +
      'the repeat count with the first and last time. The WR-n number never changes — refer ' +
      'to it (“fixed WR-12”). The file is updated in place: notes outside the markers are ' +
      'left alone. Secrets are removed before writing — in the report and in the request to ' +
      'the model. The report is written in the panel interface language — the header and ' +
      'the model texts alike; sections written before a switch keep their language until a ' +
      'repeat updates them.',
    readOnly: 'The model only reads',
    readOnlyText:
      'The analysis is launched with Claude Code and the Read, Grep and Glob tools, working ' +
      "directory = the panel's sources: a read-only launch is described and verified for it " +
      'alone. The process environment is a narrow list of variables: service keys never ' +
      'reach it. The model follows the “Panel assistant” route: no profile — the cheap tier ' +
      'of the Claude cloud; Claude switched to a local model — that same local model; a ' +
      'contour profile (including a local model handed to agents with “Connect”) — the ' +
      'analysis goes through the contour gateway and the profile sets the model. With ' +
      'another CLI active, such as Qwen Code, the analysis runs when the route leads to a ' +
      'contour or a local model: the same model answers as for the agents. If it would lead ' +
      'to the Claude cloud, the analysis does not start and the summary names the reason — ' +
      'Claude is never substituted there for the chosen CLI. An own assistant endpoint is ' +
      'refused — its token would have to be handed to a CLI process.',
    spend: 'Spend',
    spendText:
      'Tokens of every analysis add up from the moment it was started. Money — when the ' +
      'settings show spend in money — is an estimate at API rates, not a bill: on a ' +
      'subscription and on a local model nothing is charged. No problems — no model calls; ' +
      'problems are analysed in batches, at most twelve analyses an hour — beyond the cap ' +
      'they wait, and the summary says so in words.',
    trouble: 'When the watcher cannot work',
    troubleText:
      'No Claude Code on PATH — problems are written to the report without analysis. The ' +
      'report cannot be written — the watcher keeps going and names the reason. An ' +
      'analysis failed — problems wait for the next one; the analysis does not retry in a ' +
      'loop. The hourly cap is reached — problems are written as “checking” and the ' +
      'analysis resumes on its own. The route does not let the analysis run (another CLI ' +
      'with a route to the Claude cloud, an own assistant endpoint, the contour gateway down ' +
      'or no key) — problems wait, no process starts and the cap is not spent. In every case ' +
      "the reason is spelled out in the summary on the page and in the row's window.",
  },

  shots: {
    page: {
      '01-page-off':
        'The “Watcher” page while off: the “Watcher · off” row in the sidebar, the “Start the watcher” button and a hint in place of the bug form',
      '02-control-on':
        'The watcher running after its first failure: running time, spend and a finding in the report',
      '03-indicator':
        'The “Watcher” row in the sidebar and its window: summary, “Turn off”, “Open page” and the “Found a bug yourself?” form',
      '04-bug-check':
        'The row’s window after two checks: one confirmed with a section number, the other not confirmed by the code',
      '05-report':
        'The report on the page: filters with section counts and section cards, the confirmed bug’s body expanded',
    },
  },
};
