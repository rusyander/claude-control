import type { promptsRu } from '../../ru/topics/prompts';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const promptsEn: typeof promptsRu = {
  topic: {
    title: 'App prompts',
    summary: 'The texts the panel speaks to the model with, not on your behalf',
    lead:
      'Besides what you write to the agent yourself, the panel sends the model texts of ' +
      'its own: how to call tools, how to behave inside a corporate contour, what to treat ' +
      'an image description as and how to lay a topic out as slides. Such a text used to live as a string in ' +
      'the code — there was nowhere to read it and no way to adjust it to your contour. ' +
      'The «Settings → Prompts» tab shows all five in full and lets you rewrite any of ' +
      'them without losing the built-in one.',

    guideTitle: 'What this article covers',
    guideText:
      'First, why these texts are kept separately and which two layers they are made of. ' +
      'Then how to rewrite a prompt and how to bring the built-in one back, in frames of ' +
      'the real tab. After that: which five prompts exist and who reads each of them, ' +
      'what the section is NOT, what lands on disk, the limits, moving prompts to another ' +
      'machine and the refusals word for word.',

    whySee: 'You can see what the panel says',
    whySeeText:
      'A mode prompt is product behaviour: whether the model synthesises a tool call and ' +
      'what ends up on a slide depend on it. While the text sits in the code, a change of ' +
      'behaviour is noticed by a changed answer, not by a changed text.',
    whyKeep: 'An update does not eat your edit',
    whyKeepText:
      'Your text is stored apart from the built-in one, in the panel data directory. An ' +
      'update rewrites the built-in texts and never touches yours; if the built-in one ' +
      'did change, the card says so with a badge.',
    whyBack: 'There is always a way back',
    whyBackText:
      '«Reset to built-in» wipes your edit and the panel works with the repository text ' +
      'again. You can read the built-in one BEFORE that — the «Show built-in» button next ' +
      'to it — so you never go back blindly, and the panel asks once more before the ' +
      'reset itself.',

    layersTitle: 'Two layers and not one more',
    layersCaption:
      'There are exactly two layers, because a third one («a prompt per contour», «a ' +
      'prompt per project») turns «which text went to the model» into a question with ' +
      'four answers.',
    layerBuiltinTitle: 'The built-in text — the repository',
    layerBuiltinText:
      'It ships with the panel and is updated together with it. It carries a version ' +
      'number — a marker for a human: «the built-in text has been rewritten since».',
    layerOverrideTitle: 'Your edit — the panel data directory',
    layerOverrideText:
      'It appears the moment you press «Save», and from then on the panel works with it. ' +
      'While there is no edit, there is no file on disk either.',

    guide: {
      title: 'How to rewrite a prompt',
      caption: 'The «Settings → Prompts» tab: the list on top, the open text underneath.',
      careTitle: 'What saving actually changes',
      careText:
        'The saved text goes to the model in EVERY request of that mode, in full and as ' +
        'written. This is not a label on a screen: an empty prompt is a decision too, and ' +
        'the model will get an empty instruction. Edit in paragraphs and check the mode ' +
        'right after saving.',
      list: 'Open the «Prompts» tab',
      listText:
        'Five rows: the name, what the text is for, its size and an «Open» button. The ' +
        'list is deliberately cheap — it holds no texts, they load one by one.',
      open: 'Open the prompt you need',
      openText:
        'The field holds the text the panel works with right now. While there is no edit ' +
        'that is the built-in text, and the line under the buttons says so; «Reset to ' +
        'built-in» is disabled at that moment — there is nothing to reset.',
      save: 'Edit and save',
      saveText:
        'Until the text is saved, «Not saved» stands next to it: there is no autosave ' +
        'here on purpose — otherwise every typo would ride along with the next request. ' +
        'After saving, the list row gets an «Edited» badge.',
      reset: 'Back to the built-in text',
      resetText:
        '«Reset to built-in» removes your edit: the file is deleted from disk and the ' +
        'panel works with the repository text again. The «Edited» badge disappears from ' +
        'the list. The panel asks first — prompts keep no edit history — and the file ' +
        'itself goes to the backup folder before it is deleted, like any other setting ' +
        'that gets overwritten.',
    },

    catalogTitle: 'Which prompts exist',
    catalogCaption:
      'Six texts, and each one is read by exactly one place in the panel. Rewrite a ' +
      'text and the behaviour of that place changes — and nothing else.',
    catalogColumn: 'Prompt',
    catalogWhoColumn: 'Who reads it',
    promptToolProtocol: 'Tool protocol',
    promptToolProtocolText:
      'The gateway tool shim. A model with no tools of its own calls them as text in the ' +
      'grammar described here, and the panel turns such a call into a real one. Break the ' +
      'grammar and calls stop parsing.',
    promptContourAgent: 'Agent behind a contour',
    promptContourAgentText:
      'An agent run through the contour: this text REPLACES the CLI system prompt. It is ' +
      'short for a reason — a long prompt written for Claude drowns a mid-sized model, ' +
      'and tool calls then stop appearing at all.',
    promptContourPreamble: 'Contour preamble',
    promptContourPreambleText:
      'How the contour differs from a direct vendor request: whose address and key, what is ' +
      'checked in the request and the answer, why the client’s tools are described as text. ' +
      'It travels right after «Agent through the contour» as one system prompt and only ' +
      'together with it: switching the short contour prompt off drops both parts.',
    promptImage: 'Image',
    promptImageText:
      'The image mode: the system message of the DRAWING model — what it should treat the ' +
      'description as and what to do with what is left unsaid. A brief instead of a picture ' +
      'would mean text in the answer, so this is not a request rewriter. It travels only on ' +
      'the «part of the answer» road: the separate images endpoint has no system message, and ' +
      'the panel says so in the mode menu. The panel draws the illustrations of presentation ' +
      'slides with this very text.',
    promptImageSvg: 'Picture as code',
    promptImageSvgText:
      'The agent road: the drawing is made not by a provider endpoint but by the ' +
      'conversation agent itself — as SVG code. The text also describes what the panel ' +
      'CHECKS when accepting a drawing: no scripts, no links out, no external fonts — ' +
      'otherwise the file would stop being self-contained and the panel rejects it. The rest ' +
      'is the rules of a good drawing: margin, grid, contrast, label sizes.',
    promptPresentation: 'Presentation',
    promptPresentationText:
      'The presentation mode, one text for all three roads: a topic becomes the structure of ' +
      'a deck. It names the seven slide layouts and six colour moods, the order of the story ' +
      '(claim — sections — numbers and diagrams — conclusion), the rules for a diagram as ' +
      'code and for the description of a photographic image the panel will draw, and the ' +
      'duty of the agent to ask about the size of the deck first. The panel ceilings are ' +
      'listed too: the trimming is done by the panel, not by the model.',

    notTitle: 'What this is not',
    notCaption:
      'The word «prompt» means four different things in the panel. This section is only ' +
      'the fifth one: the texts of the panel itself.',
    notColumn: 'Not this',
    notMeaningColumn: 'Where it actually lives',
    notChat: 'Not what you write to the agent',
    notChatText:
      'Your chat message is never taken from here. These texts are what the panel adds on ' +
      'its own, and they are not visible in the chat.',
    notCli: 'Not the CLI system prompt as such',
    notCliText:
      'Claude Code keeps its own prompt. Only one pair from here replaces it — «Agent ' +
      'through the contour» followed by «Contour preamble», and only on runs through the ' +
      'contour.',
    notClaudeMd: 'Not CLAUDE.md and not rules',
    notClaudeMdText:
      'Standing instructions to the agent live in «CLAUDE.md», «Rules» and «Skills». They ' +
      'are about HOW to work with your code; this section is about what the panel speaks ' +
      'to the model with.',
    notPerProject: 'Not a project setting',
    notPerProjectText:
      'A prompt is one per panel. Neither a project nor a contour has a text of its own — ' +
      'otherwise «which text went to the model» would have four answers at once.',
    notShared: 'Not shared between machines',
    notSharedText:
      'Your edit lives on this machine. You can carry it over in an environment transfer ' +
      'archive — but that is a one-off action, not a text shared by two machines.',

    storageCaption:
      'The built-in text lives in the panel files, yours in its data directory. The panel ' +
      'cannot write into the built-in one: that arrives with an update.',
    storageBuiltin: 'Built-in text',
    storageBuiltinValue: 'apps/server/src/domains/prompts/catalog/<prompt>.md',
    storageOverride: 'Your edit',
    storageOverrideValue: '~/.claude/agentdeck/prompts/<prompt>.md',
    storageIndex: 'The edit record',
    storageIndexValue: '~/.claude/agentdeck/prompts/index.json',
    storageSeen: 'When the model sees it',
    storageSeenValue:
      'On the next request of that mode: the text is read per request, no panel restart ' +
      'needed.',

    canRead:
      'Read any of the five prompts in full — the working text and the built-in one beside it',
    canEdit: 'Rewrite a text and save it for this machine',
    canReset: 'Bring the built-in text back with one button',
    canNotice: 'See that a panel update rewrote the built-in text',
    canTransfer: 'Carry your edits over in an environment transfer archive',
    canSurvive: 'Survive a panel update: your edit is left alone',
    cantBuiltin: 'Change the built-in text — it arrives with an update',
    cantPerProject: 'Keep a prompt of your own per project, contour or chat',
    cantVersion: 'Keep a history of your edits: the last one is stored',
    cantCheck: 'Test the text against a model from this tab — test it through the mode',
    cantHighlight: 'Syntax highlighting and a markup preview — there are none here',

    refusalsTitle: 'Refusals word for word',
    refusalsCaption: 'What the panel answers and what it means.',
    refusalsColumn: 'Message',
    refusalsMeaningColumn: 'What happened',
    refusalUnknown: 'No such prompt in the catalog',
    refusalUnknownText:
      'An address with an unknown identifier. Usually a link out of an archive built by a ' +
      'newer panel than yours.',
    refusalEmpty: 'The prompt text is required',
    refusalEmptyText:
      'A save arrived without a text. An empty text is not the same as a reset: the ' +
      'built-in one comes back only through «Reset to built-in».',
    refusalTooLong: 'The prompt is longer than 64 KB',
    refusalTooLongText:
      'The length ceiling. It is in BYTES, not characters: Cyrillic weighs twice as much, ' +
      'and a megabyte-long prompt means a token bill on every request and a truncated ' +
      'context for the model.',
    refusalBroken: 'The prompts section is damaged: it does not parse as JSON',
    refusalBrokenText:
      'The transfer archive brought a broken prompts file. The rest of the archive is ' +
      'applied as usual — the plan lists it separately.',
    refusalNewer: 'The prompts section is newer than the supported version',
    refusalNewerText:
      'The archive was built by a newer panel. Its prompts are not applied: their layout ' +
      'may have changed.',

    transferTitle: 'Moving to another machine',
    transferCaption:
      'Edits travel together with the provider environment — «Settings → Transfer», the ' +
      '«Export» button next to the provider you need.',
    transferOnlyTitle: 'Only your edits travel',
    transferOnlyText:
      'There are no built-in texts in the archive at all. Otherwise the new machine would ' +
      'show you a «built-in» text of SOMEONE ELSE’S panel version — the archive ' +
      'carries the difference, not the whole catalog.',
    transferPlanTitle: 'The plan shows every edit',
    transferPlanText:
      'In the import plan prompts stand as their own list: «new» — this prompt was never ' +
      'edited here, «identical» — the texts match, «overwrites» — your text will be ' +
      'replaced. Only new ones are ticked in advance; your own edit is replaced only by ' +
      'your own tick.',
    transferUnknownTitle: 'What applying cannot do',
    transferUnknownText:
      'Overwrite the built-in text: there is nowhere to write it — it lives in the panel ' +
      'files. A prompt with an unfamiliar identifier (an archive built by a newer panel) ' +
      'is skipped: a file nobody will ever read is not left on disk.',

    notesTitle: 'Fine points',
    noteChangedTitle: 'The «Built-in updated» badge is not an error',
    noteChangedText:
      'It means exactly one thing: the panel was updated, the built-in text of this ' +
      'prompt was rewritten, and yours stayed as it was. Yours is still the one in use. ' +
      'It is a reason to re-read the built-in one — it may have gained something yours ' +
      'lacks.',
    noteSameTitle: 'A text equal to the built-in one is not an edit',
    noteSameText:
      'Save a text that exactly equals the built-in one and the edit is removed rather ' +
      'than stored empty. Otherwise the list would show «Edited» next to a prompt that ' +
      'differs in nothing.',
    noteBytesTitle: 'The text travels byte for byte',
    noteBytesText:
      'The panel does not adjust line endings and does not preserve the shape of the ' +
      'previous file: the model gets exactly the bytes you saved. For the same reason the ' +
      'built-in catalog is excluded from code auto-formatting.',
    noteBreakTitle: 'A broken prompt breaks the mode, not the panel',
    noteBreakText:
      'The panel does not check that a text is «correct» — only a model can. If a mode ' +
      'stopped working after your edit (tool calls do not parse, slides do not assemble), ' +
      'press «Show built-in» first and compare — no need to wipe your own text for that.',
  },

  shots: {
    library: {
      '01-list':
        'The «Prompts» tab: five texts, each with what it is for, its size and an «Open» button',
      '02-builtin':
        '«Agent behind a contour» is open: the built-in text in full, «Reset to built-in» disabled — there is no edit',
      '03-edited':
        'After saving: an «Edited» badge in the list row, the reset button became available',
      '04-reset':
        'After the reset: the badge is gone, the field holds the built-in text again and the panel works with it',
    },
  },
};
