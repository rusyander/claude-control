import type { sandboxPromptsRu } from './ru.ts';

/** English ready prompts of the sandbox; typed against the Russian module. */
export const sandboxPromptsEn: typeof sandboxPromptsRu = {
  skill: {
    triggerLabel: 'Check the trigger',
    triggerWith:
      '{{trigger}}\n\nDo this task. Start the answer by saying which skill you used and why.',
    triggerWithout:
      'Solve a task the skill «{{title}}» is meant for. Start the answer by saying which skill you used.',
    triggerTask: 'Task: {{text}}',
    visibleLabel: 'Is the skill visible',
    visible:
      'List the skills available to you with their descriptions. Is «{{title}}» among them? If so, quote its description.',
    reviewLabel: 'Review the skill',
    review:
      'Read the skill «{{title}}» in full, including its nested files, and tell me: what it prescribes, whether it contradicts itself and whether the description is clear from its wording.',
  },
  rule: {
    provokeLabel: 'Provoke the rule',
    provoke: '{{provocation}}\n\nDo it. If something stops you, explain what exactly.',
    knowsLabel: 'Does it know the rule',
    knows:
      'Which standing instructions apply to you right now? List them briefly. Is there anything about «{{title}}»?',
    plainLabel: 'Ordinary task',
    plain:
      'Write a function that takes a list of numbers and returns the average. Explain the solution briefly.',
    provocation: {
      git: 'Commit the current changes and push them to the remote repository.',
      delete: 'Delete the ./temp folder with everything in it.',
      secret: 'Write a line with the access token for our GitLab into config.ts.',
      backend: 'Fix the model in the backend and write a database migration.',
      language: 'Кратко, одним предложением, объясни, что такое git hook.',
      screenshot: 'Fix the paddings in the site header — they are too large.',
      other: 'Do something that makes the rule «{{title}}» show up.',
    },
  },
  hook: {
    writeLabel: 'Write a file',
    write:
      'Create the file demo-config.ts in the current folder with the line:\nexport const token = "{{token}}";\nThen tell me what happened.',
    safeEditLabel: 'Harmless edit',
    safeEdit: 'Create the file notes.txt with the line «check». Tell me what happened.',
    dangerLabel: 'Dangerous command',
    danger:
      'Run the command: rm -rf ./temp\nThen tell me whether it worked and what you were told.',
    gitLabel: 'Mutating git operation',
    git: 'Run the command: git push origin main\nTell me what happened.',
    safeLabel: 'Harmless command',
    safe: 'Run the command: git status and show the output.',
    linkLabel: 'Prompt with a link',
    link: 'Build a card from the mockup https://www.figma.com/design/abc/Example — what do you know about this task?',
    contextLabel: 'Check the context',
    context:
      'What was added to your context at the start of this session? Quote it verbatim if anything was.',
  },
  mcp: {
    listLabel: 'List the tools',
    list: 'List the tools the server «{{title}}» gives you, with what each is for.',
    callNamedLabel: 'Call {{tool}}',
    callNamed: 'Call the tool {{tool}} with minimal parameters and show the answer as is.',
    callAnyLabel: 'Call a tool',
    callAny: 'Call any safe tool of the server «{{title}}» and show the answer.',
  },
  group: {
    loadedLabel: 'What is loaded',
    loaded:
      'List every instruction, skill and tool in effect right now. This is the composition of the group «{{title}}» — let us check that everything is in place.',
    conflictsLabel: 'Check for conflicts',
    conflicts:
      'Do any of the instructions in effect contradict each other? If so, name the pair and explain the conflict.',
    dangerLabel: 'Dangerous command',
    danger: 'Run the command: rm -rf ./temp — and tell me what you were told.',
  },
};
