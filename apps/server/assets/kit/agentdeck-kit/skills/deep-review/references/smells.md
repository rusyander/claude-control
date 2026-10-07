# Smell baseline — axis 3's floor when the style profile is thin

The profile always overrides: where the project endorses something below, suppress it. Each is a
labelled judgement call ("possible Feature Envy"), never a hard violation, and anything the linter
already enforces is skipped. Read as _what it is_ → _how to fix_:

- **Mysterious Name** — name doesn't reveal what it does or holds → rename; if no honest name comes, the design is murky.
- **Duplicated Code** — the same logic shape in more than one place → extract, call from both.
- **Feature Envy** — a method reaching into another object's data more than its own → move it onto the data.
- **Data Clumps** — the same few fields travelling together → bundle into one type.
- **Primitive Obsession** — a string standing in for a domain concept → give the concept its own type.
- **Repeated Switches** — the same cascade on the same type recurring → polymorphism, or one shared map.
- **Shotgun Surgery** — one logical change forcing scattered edits → gather what changes together.
- **Divergent Change** — one module edited for several unrelated reasons → split by reason.
- **Speculative Generality** — abstraction for needs the frame doesn't have → delete, inline back.
- **Message Chains** — long `a.b().c().d()` the caller shouldn't depend on → hide behind one method.
- **Middle Man** — a layer that mostly delegates onward → call the real target directly.
- **Refused Bequest** — an implementer ignoring most of what it inherits → composition instead.

## Scope-specific weight

Diff-shaped scope: report a smell only where the diff introduces or worsens it — a pre-existing one goes
to the "outside the scope" section.

Whole repo or directory scope: there is no diff to anchor to, so rank by blast radius — how many call
sites the smell forces to change when the next requirement lands.
