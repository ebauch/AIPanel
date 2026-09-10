# AI Panel

A local Next.js app where you put a question to a panel of AI models and watch them
debate it, then walk away with what they agree on. 

<img width="1260" height="827" alt="ai_panel_screenshot" src="https://github.com/user-attachments/assets/c0f0b77b-c705-43b4-883f-c739d08cd645" />

Paste a context brief, attach
source documents (PDF, URL, or pasted text), pick the debaters from any model
available on [OpenRouter](https://openrouter.ai), and watch the panel argue it out
over multiple rounds — live, streamed straight to the browser. When they finish,
the page turns into a results view: a verdict, the to-dos every model backed, and
the points they still fight over.

## Features

- **Three debate modes**
  - `conversation` — honest analysis, no assigned stance
  - `assigned_stances` — fixed positions split across models
  - `randomized_stances` — multiple iterations with shuffled stance assignments
- **Source documents** — paste text, upload a PDF, or fetch a URL (with a
  Wikipedia-aware extractor); documents are inlined into every prompt since the
  model has no memory between turns
- **Examples** — three ready-made debates you can load with one click
- **Transcript sharing** — the orchestrator holds the canonical transcript; each
  turn includes only messages from other debaters since that speaker's last turn
- **Streaming UI** — live SSE transcript grouped by iteration → round → speaker,
  with collapsible "Thinking" blocks for models that stream reasoning
- **Takeaways, not a wall of text** — once the debate ends, a takeaways model
  distills a verdict, the concrete takeaways the whole panel agreed on (with a
  per-model vote strip), the ones that stayed contested, and any genuine splits.
  The full transcript is still there behind a "Show debate" toggle
- **Cost indicator** — a live estimate before you start, and running totals (in
  tokens and USD) as the debate streams
- **Export to Markdown** — download the transcript, the takeaways (as a task list
  for agreed actions), or both

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example env file and add your API key:

```bash
cp .env.local.example .env.local
```

Set `OPENROUTER_API_KEY` from [openrouter.ai/keys](https://openrouter.ai/keys).
Alternatively, skip the env file and paste a key on the **Settings** page — it
stays in your browser and is sent only to this app's own server, which forwards
it to OpenRouter.

3. Start the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Enter a context brief describing the question or situation under debate.
2. Add one or more labeled documents — paste text, upload a PDF, or fetch a URL.
3. Select at least two debater models (a recommended set is preselected).
4. Choose a debate mode, reasoning effort, and number of rounds.
5. For stance modes, edit the default stance labels if needed.
6. Click **Run debate** and watch the live transcript stream in.
7. Once it's done, the page becomes the result: a **verdict**, the takeaways
   **agreed by the whole panel**, and the ones that stayed **contested** — each
   with a vote strip showing who backed it. Click **Show debate** to see the
   full transcript, or **Export** to download it as Markdown (agreed actions
   come out as a task list).

Or just click one of the **Examples** to see it in action.

## Project structure

```
app/
  api/debate/route.ts     # SSE streaming POST endpoint for a full debate
  api/summarize/route.ts  # SSE streaming POST endpoint for the takeaways
  api/models/route.ts     # GET available OpenRouter models
  api/fetch-url/route.ts  # POST a URL, get back extracted text
  api/extract-pdf/route.ts# POST a PDF, get back extracted text
  page.tsx                # Debate form + live transcript + results UI
  components/Markdown.tsx # Shared markdown renderer (react-markdown + remark-gfm)
  settings/page.tsx       # API key + prompt template editor
lib/
  debate.ts               # Orchestrator (stances, turns, rounds, iterations)
  summarize.ts            # Takeaways generation (JSON parsing, validation)
  openrouter.ts           # OpenRouter HTTP client (streaming chat completions)
  models.ts               # Model catalog: filtering, recommended flagships
  prompts.ts               # Prompt/message builders (seed, rebuttal, takeaways)
  prompt-templates.ts     # Default editable prompt templates
  cost.ts                  # Token/cost estimation
  examples.ts              # Example debate type
  types.ts                 # Shared config, takeaways, and stream event types
```

## Defaults

- 3 rounds
- Reasoning effort: `high`
- Randomized mode: 3 iterations
- Default stances: Pro / Against / Balanced
- Default selected models: the recommended flagship from each of Anthropic,
  OpenAI, Google, and xAI (up to 3)

## Build

```bash
npm run build
npm start
```

The app builds without `OPENROUTER_API_KEY`; runtime routes return a clear
error if no key is configured (env var or saved in the browser).

## Notes on OpenRouter

- Model calls go straight to `https://openrouter.ai/api/v1/chat/completions`
  over SSE — no SDK, no local agent workspace.
- Documents are inlined into every prompt (not memorized across turns), so
  each turn resends the context brief and source documents alongside the
  running transcript since that speaker's last turn.
- Reasoning effort maps to OpenRouter's `reasoning.effort` parameter
  (`normal` → `medium`, `high` → `high`) and is only sent for models that
  support it.
