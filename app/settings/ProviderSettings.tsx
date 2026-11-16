"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiHeaders } from "@/lib/api-key-store";

interface ProviderInfo {
  id: string;
  label: string;
  kind: "api" | "subscription";
  efforts: string[];
  status: { state: "ready" | "missing" | "error"; detail: string };
  offeredModels: Array<{ id: string; displayName: string }>;
}

interface EnabledModel {
  id: string;
  label: string;
  effort?: string;
}

interface TestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  error?: string;
  durationMs: number;
}

const STATUS_STYLES: Record<ProviderInfo["status"]["state"], string> = {
  ready: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  missing: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "bg-red-500/10 text-red-700 dark:text-red-300",
};

const STATUS_LABELS: Record<ProviderInfo["status"]["state"], string> = {
  ready: "ready",
  missing: "not set up",
  error: "problem",
};

const SECTION_CLASS =
  "mb-6 rounded-2xl bg-white p-5 ring-1 ring-black/5 dark:bg-zinc-950";
const INPUT_CLASS =
  "rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm outline-none ring-violet-500 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900";
const SECONDARY_BUTTON_CLASS =
  "rounded-xl border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

function providerOfModelId(id: string): string {
  return id.slice(0, id.indexOf(":"));
}

/**
 * Settings → Providers (status + test call) and Models (the enabled list the
 * debate picker shows). Models are stored server-side via /api/settings/models
 * so every device sees the same picker.
 */
export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [models, setModels] = useState<EnabledModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const [newProvider, setNewProvider] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newEffort, setNewEffort] = useState("");

  const load = useCallback(() => {
    void Promise.all([
      fetch("/api/providers", { headers: apiHeaders() }).then((r) => r.json()),
      fetch("/api/settings/models").then((r) => r.json()),
    ])
      .then(
        ([providerData, modelData]: [
          { providers?: ProviderInfo[] },
          { models?: EnabledModel[]; warning?: string },
        ]) => {
          setProviders(providerData.providers ?? []);
          setModels(modelData.models ?? []);
          setLoadError(modelData.warning ?? null);
          setNewProvider((current) => current || providerData.providers?.[0]?.id || "");
        },
      )
      .catch(() => setLoadError("Could not load providers or models."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (next: EnabledModel[]) => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/settings/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: next }),
      });
      const data = (await response.json()) as { models?: EnabledModel[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Save failed.");
      }
      setModels(data.models ?? next);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const runTest = useCallback(async (providerId: string) => {
    setTesting(providerId);
    try {
      const response = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders() },
        body: JSON.stringify({ providerId }),
      });
      const data = (await response.json()) as TestResult;
      setTestResults((current) => ({ ...current, [providerId]: data }));
    } catch {
      setTestResults((current) => ({
        ...current,
        [providerId]: { ok: false, error: "Request failed.", durationMs: 0 },
      }));
    } finally {
      setTesting(null);
    }
  }, []);

  const selectedProvider = useMemo(
    () => providers?.find((provider) => provider.id === newProvider),
    [providers, newProvider],
  );

  const handleAdd = async () => {
    const model = newModel.trim();
    if (!selectedProvider || !model || !models) {
      return;
    }
    const offered = selectedProvider.offeredModels.find((entry) => entry.id === model);
    const entry: EnabledModel = {
      id: `${selectedProvider.id}:${model}`,
      label: newLabel.trim() || offered?.displayName || model,
      ...(newEffort ? { effort: newEffort } : {}),
    };
    if (models.some((existing) => existing.id === entry.id)) {
      setSaveError(`${entry.id} is already enabled.`);
      return;
    }
    if (await save([...models, entry])) {
      setNewModel("");
      setNewLabel("");
      setNewEffort("");
    }
  };

  const providerLabel = (id: string) =>
    providers?.find((provider) => provider.id === id)?.label ?? id;

  return (
    <>
      <section className={SECTION_CLASS}>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              Providers
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Subscription providers run through the logged-in{" "}
              <code>claude</code> and <code>codex</code> CLIs on this machine,
              so debates are paid by Claude Max / ChatGPT Pro, not per token.
            </p>
          </div>
          <button type="button" onClick={load} className={SECONDARY_BUTTON_CLASS}>
            Refresh
          </button>
        </div>
        {loadError && (
          <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {loadError}
          </p>
        )}
        {!providers && !loadError && <p className="text-sm text-zinc-500">Loading…</p>}
        <ul className="space-y-3">
          {providers?.map((provider) => {
            const result = testResults[provider.id];
            return (
              <li
                key={provider.id}
                className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{provider.label}</p>
                    <p className="text-xs text-zinc-500">
                      <span
                        className={`mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[provider.status.state]}`}
                      >
                        {STATUS_LABELS[provider.status.state]}
                      </span>
                      {provider.status.detail}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void runTest(provider.id)}
                    disabled={testing !== null}
                    className={SECONDARY_BUTTON_CLASS}
                    title="Sends one tiny prompt through this provider"
                  >
                    {testing === provider.id ? "Testing…" : "Test"}
                  </button>
                </div>
                {result && (
                  <p
                    className={`mt-2 break-words text-xs ${
                      result.ok
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-red-700 dark:text-red-300"
                    }`}
                  >
                    {result.ok
                      ? `OK — ${result.model} replied “${result.reply}” in ${(result.durationMs / 1000).toFixed(1)}s`
                      : `Failed${result.model ? ` (${result.model})` : ""}: ${result.error}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className={SECTION_CLASS}>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Models
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Enabled models appear in the debate picker, grouped by provider.
            The full OpenRouter catalog is always listed; an OpenRouter model
            added here only gets your label (or is added if the catalog lacks
            it).
          </p>
        </div>
        {saveError && (
          <p className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {saveError}
          </p>
        )}
        {models && models.length === 0 && (
          <p className="mb-2 text-sm text-zinc-500">No models enabled.</p>
        )}
        <ul className="mb-4 divide-y divide-zinc-200 dark:divide-zinc-800">
          {models?.map((model) => (
            <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{model.label}</p>
                <p className="font-mono text-[11px] text-zinc-500">
                  {model.id} · {providerLabel(providerOfModelId(model.id))}
                  {model.effort ? ` · effort ${model.effort}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void save(models.filter((entry) => entry.id !== model.id))}
                disabled={saving}
                className={SECONDARY_BUTTON_CLASS}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="space-y-2 rounded-xl border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Add model</p>
          <div className="flex flex-wrap gap-2">
            <select
              value={newProvider}
              onChange={(event) => {
                setNewProvider(event.target.value);
                setNewModel("");
                setNewEffort("");
              }}
              className={INPUT_CLASS}
              aria-label="Provider"
            >
              {providers?.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
            <input
              list="offered-models"
              value={newModel}
              onChange={(event) => setNewModel(event.target.value)}
              placeholder="Pick from the list or type an id"
              className={`${INPUT_CLASS} min-w-0 flex-1`}
              aria-label="Model id"
            />
            <datalist id="offered-models">
              {selectedProvider?.offeredModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </datalist>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="Label (optional)"
              className={`${INPUT_CLASS} min-w-0 flex-1`}
              aria-label="Label"
            />
            {selectedProvider && selectedProvider.efforts.length > 0 && (
              <select
                value={newEffort}
                onChange={(event) => setNewEffort(event.target.value)}
                className={INPUT_CLASS}
                aria-label="Effort"
              >
                <option value="">Effort: follow debate setting</option>
                {selectedProvider.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    Effort: {effort}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={saving || !newModel.trim() || !selectedProvider}
              className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
