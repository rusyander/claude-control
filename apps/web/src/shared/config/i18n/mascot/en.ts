import type { mascotRu } from './ru.ts';

/** English texts of the panel mascot; typed against the Russian module. */
export const mascotEn: typeof mascotRu = {
  name: 'Decky',
  role: 'panel mascot',
  buttonAria: 'Decky: {{status}}. Open the summary',
  status: {
    idle: 'all quiet',
    sleeping: 'dozing',
    working_one: '{{count}} agent working',
    working_few: '{{count}} agents working',
    working_many: '{{count}} agents working',
    working_other: '{{count}} agents working',
    waiting_one: '{{count}} chat waits for you',
    waiting_few: '{{count}} chats wait for you',
    waiting_many: '{{count}} chats wait for you',
    waiting_other: '{{count}} chats wait for you',
    error_one: '{{count}} agent failed',
    error_few: '{{count}} agents failed',
    error_many: '{{count}} agents failed',
    error_other: '{{count}} agents failed',
  },
  speech: {
    greet:
      "Hi! I'm Decky. I keep an eye on the agents and call you when one waits for an answer or is done. Click me for a summary.",
    ask: '“{{name}}” is waiting for your answer',
    done: 'Done! “{{name}}” finished its turn.',
    doneAnonymous: 'Done! An agent finished its turn.',
    error: 'Something went wrong in “{{name}}” — have a look at the chat.',
    errorAnonymous: 'An agent failed — have a look at the chat.',
    wake: "Oh! I wasn't asleep, I was watching the agents with my eye closed.",
    dizzy: 'Whoa, my head is spinning…',
  },
  react: {
    linkLost: [
      'Lost the connection to the panel server. Waiting for it to come back.',
      'The panel server is not answering — what you see may be out of date.',
      'I lost sight of the panel server. Trying to reach it again.',
    ],
    linkBack: [
      'The server is back — the data is up to date again.',
      'Connected again, everything on screen is fresh.',
      'We are back! I pulled in everything that changed meanwhile.',
    ],
    runFailed: [
      'Something went wrong in “{{name}}” — have a look at the chat.',
      'The turn in “{{name}}” failed. The reason is in the chat.',
      '“{{name}}” tripped over an error. See what happened.',
    ],
    groupFailed: [
      'Group “{{name}}” failed — details on its hub card.',
      'Group “{{name}}” broke down. The hub shows why.',
      'Group “{{name}}” did not get to the end — check the hub.',
    ],
    groupStopped: [
      'Group “{{name}}” has been stopped.',
      'Group “{{name}}” is standing — you can resume it from the hub.',
      '“{{name}}” is paused, its queue slot went to others.',
    ],
    limitHit: [
      'We hit the subscription limit — the turn waits for the window to reset.',
      'The subscription limit is used up. We carry on after the reset.',
      'The subscription window ran out — we have to wait for the reset.',
    ],
    longDone: [
      'The long turn in “{{name}}” is finished — ready to look at.',
      '“{{name}}” is finally done. It took a while, but it is ready.',
      'Done: “{{name}}” got to the end of a long turn.',
    ],
    groupDelivered: [
      'Group “{{name}}” delivered!',
      'Group “{{name}}” is finished — the result is in the hub.',
      '“{{name}}” delivered. Ready to check and accept.',
    ],
  },
  panel: {
    title: 'Decky',
    subtitle: 'Agents at a glance',
    running: 'Working now',
    waiting: 'Waiting for your answer',
    errors: 'Failed',
    allQuiet: 'No agent is working and nobody is waiting for an answer.',
    open: 'Open',
    openChat: 'Open the chat',
    more: 'and {{count}} more',
    tipTitle: 'Tip',
    nextTip: 'Another tip',
    chatty: 'Remarks and tips',
    hide: 'Hide Decky',
    hidden: 'Decky is hidden. Bring him back in “Settings → General”.',
    untitled: 'Untitled',
  },
  tips: {
    palette: 'Ctrl+K (⌘K on a Mac) or “/” opens the command palette — it gets you anywhere.',
    jump: '“g” followed by a letter jumps to a section: g c — chat, g r — rules, g m — MCP, g s — settings.',
    help: '“?” opens the help. Every section has its own page explaining it.',
    notify:
      'An agent in another project is done or waiting for you? A sound and a notification tell you — no need to watch the screen.',
    bell: 'The bell in the sidebar keeps recent notifications — anything you missed is there.',
    limits: 'Subscription limits sit at the top of the sidebar and refresh on their own.',
    panelAgent:
      'The panel agent changes settings when asked in words: it opens the right page itself, and you decide whether to apply the change.',
    accent: 'Theme and accent colour live in “Settings → General”. I repaint along with the panel.',
    me: 'Click me to see which agents are working, which wait for an answer and which failed.',
    steer: 'While an agent works you can still write to it: your words reach it at its next step.',
    enter: 'Enter sends the message, Shift+Enter starts a new line.',
    drop: 'Drop a file right into the input — it goes with the message as an attachment.',
    draft:
      'An unfinished message is not lost: the draft is kept even if you leave for another section.',
    tabs: 'Project tabs can be dragged with the mouse, and Alt+←/→ on a tab moves it one step.',
    reduceMotion:
      'If animations get in the way, turn on “Reduce motion” on the “General” tab — I will calm down too.',
    quiet:
      'Remarks can be turned off with the “Remarks and tips” switch — in my summary or here on “General”.',
  },
  cameo: {
    working:
      'The agent is working. Feel free to leave for another section — I will call you when it is done.',
    long: 'A tough one. The progress shows in the feed above, I am right here.',
    veryLong: 'A long turn. If the agent needs an answer, I will tell you at once.',
  },
  greeting: {
    tip: 'A tip from Decky',
    next: 'Next tip',
  },
  notFound: 'I searched the whole panel — there is no such page here.',
  crash: 'Something broke and my head is spinning. Please try again.',
  settings: {
    title: 'Mascot',
    show: 'Show Decky',
    showHint:
      'At the bottom of the sidebar: an agent summary, remarks about finished turns and questions, cameos in the chat.',
    chatty: 'Remarks and tips',
    chattyHint:
      'Every now and then Decky suggests panel features and comments on long turns in the chat. Messages about questions and finished turns stay.',
    reactions: 'Reactions to events',
    reactionsHint:
      'The server connection lost or back, a turn or a group failed, a group stopped or delivered, the subscription limit hit, a long turn finished. One short line, at most once a minute per event; in the chat — above the input field. Off — Decky reports a failed turn with the old single line and stays silent about the rest.',
  },
};
