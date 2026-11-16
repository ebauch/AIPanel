---
name: debate
description: Put a debatable question to the AIPanel model panel (Opus 5.5 vs Astra by default) and report its verdict. Use when the user runs /debate <topic> or asks to have the panel debate something.
argument-hint: <topic or question>
---

# /debate

1. **Question.** Use the user's topic as `question`, phrased as the decision or
   claim to debate. If it is too vague to argue, ask one short question first.
2. **Context.** Put background the user gave or that the conversation
   established into `context` (facts, constraints, what was already tried).
   Files or URLs the user referenced go into `documents` as absolute paths or
   http(s) URLs; do not paste their contents into `context`.
3. **Settings.** Only pass a setting (models, preset, rounds, mode, stances…)
   when the user asked for it. Call `list_models` if they named models or a
   preset you need to resolve.
4. **Run** the `debate` tool of the `aipanel` MCP server. It takes minutes;
   tell the user it is running.
5. **Report**, in this order, using the panel's own words:
   - the **verdict** (quote it; do not reword, soften or extend it),
   - the **to-dos every model backed**,
   - the **open disagreements**,
   - the transcript path as a link, and the debate id.
   Add your own view only if the user asks, and label it as yours.
6. **Follow-ups** on the same topic ("ask them about X", "one more round") go to
   `continue_debate` with that id, not a new debate. `list_debates` finds
   earlier ones.

If a tool returns an error, show it as is and say which input to fix.
