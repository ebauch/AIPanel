"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_STAGES,
  type PromptStageKey,
} from "@/lib/prompt-templates";
import {
  effectivePromptTemplate,
  isPromptOverrideModified,
  readPromptOverride,
  resetAllPromptOverrides,
  resetPromptOverride,
  writePromptOverride,
} from "@/lib/prompt-store";
import { clearApiKey, readApiKey, writeApiKey } from "@/lib/api-key-store";

function ApiKeySection() {
  const [key, setKey] = useState(() => readApiKey() ?? "");
  const [savedKey, setSavedKey] = useState<string | null>(() => readApiKey());
  const [status, setStatus] = useState<"idle" | "saved" | "cleared">("idle");

  const handleSave = () => {
    if (!key.trim()) {
      return;
    }
    writeApiKey(key);
    setSavedKey(key.trim());
    setStatus("saved");
  };

  const handleClear = () => {
    clearApiKey();
    setKey("");
    setSavedKey(null);
    setStatus("cleared");
  };

  return (
    <section className="mb-6 rounded-2xl bg-white p-5 ring-1 ring-black/5 dark:bg-zinc-950">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          OpenRouter API key
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Get a key from{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-violet-600 hover:underline"
          >
            openrouter.ai/keys
          </a>
          .
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setStatus("idle");
          }}
          placeholder="sk-or-v1-…"
          className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm outline-none ring-violet-500 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!key.trim()}
          className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={!savedKey}
          className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Clear
        </button>
      </div>
      {status === "saved" && (
        <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
          Key saved to this browser.
        </p>
      )}
      {status === "cleared" && (
        <p className="mt-2 text-xs text-zinc-500">Key cleared.</p>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        The key stays in this browser (localStorage) and is sent only to this
        app&apos;s local server, which forwards it to OpenRouter for each
        request. If no key is saved here, the server falls back to the
        <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-900">
          OPENROUTER_API_KEY
        </code>
        variable in <code>.env.local</code>.
      </p>
    </section>
  );
}

export default function SettingsPage() {
  const stages = useMemo(
    () => Object.keys(PROMPT_STAGES) as PromptStageKey[],
    [],
  );
  const [templates, setTemplates] = useState<Record<PromptStageKey, string>>(
    () => {
      const initial = {} as Record<PromptStageKey, string>;
      for (const stage of stages) {
        initial[stage] = effectivePromptTemplate(stage);
      }
      return initial;
    },
  );
  const [modified, setModified] = useState<Record<PromptStageKey, boolean>>(
    () => {
      const initial = {} as Record<PromptStageKey, boolean>;
      for (const stage of stages) {
        initial[stage] = isPromptOverrideModified(stage);
      }
      return initial;
    },
  );

  const handleChange = (stage: PromptStageKey, value: string) => {
    setTemplates((current) => ({ ...current, [stage]: value }));
    writePromptOverride(stage, value);
    setModified((current) => ({
      ...current,
      [stage]: value !== DEFAULT_PROMPT_TEMPLATES[stage],
    }));
  };

  const handleResetStage = (stage: PromptStageKey) => {
    resetPromptOverride(stage);
    setTemplates((current) => ({
      ...current,
      [stage]: DEFAULT_PROMPT_TEMPLATES[stage],
    }));
    setModified((current) => ({ ...current, [stage]: false }));
  };

  const handleResetAll = () => {
    resetAllPromptOverrides();
    const nextTemplates = {} as Record<PromptStageKey, string>;
    const nextModified = {} as Record<PromptStageKey, boolean>;
    for (const stage of stages) {
      nextTemplates[stage] = DEFAULT_PROMPT_TEMPLATES[stage];
      nextModified[stage] = false;
    }
    setTemplates(nextTemplates);
    setModified(nextModified);
  };

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 lg:px-8">
      <div className="mb-8 space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Settings
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Prompt templates
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Edit debate and summary prompts locally. Changes apply to the next run
          from the{" "}
          <Link href="/" className="font-medium text-violet-600 hover:underline">
            Debate
          </Link>{" "}
          page.
        </p>
      </div>

      <ApiKeySection />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleResetAll}
          className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Reset all to defaults
        </button>
      </div>

      <div className="space-y-6">
        {stages.map((stage) => {
          const meta = PROMPT_STAGES[stage];
          return (
            <section
              key={stage}
              className="rounded-2xl bg-white p-5 ring-1 ring-black/5 dark:bg-zinc-950"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    {meta.title}
                  </h2>
                  {"description" in meta && meta.description && (
                    <p className="mt-1 text-xs text-zinc-500">
                      {meta.description}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-zinc-500">
                    Placeholders:{" "}
                    {meta.vars.length > 0
                      ? meta.vars.map((name) => `{{${name}}}`).join(", ")
                      : "(none)"}
                  </p>
                </div>
                {modified[stage] && (
                  <span className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
                    Modified
                  </span>
                )}
              </div>
              <textarea
                value={templates[stage]}
                onChange={(event) => handleChange(stage, event.target.value)}
                rows={14}
                spellCheck={false}
                className="w-full rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-xs leading-5 outline-none ring-violet-500 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
              {stage === "summary" && (
                <p className="mt-2 text-xs text-zinc-500">
                  The JSON output format instructions are appended automatically
                  after this template — no need to specify them here.
                </p>
              )}
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => handleResetStage(stage)}
                  disabled={!modified[stage] && !readPromptOverride(stage)}
                  className="text-sm font-medium text-violet-600 hover:text-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Reset to default
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
