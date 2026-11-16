// Model ids are `provider:modelId` (e.g. `claude-cli:claude-opus-5-5`).
//
// OpenRouter ids stay bare (`anthropic/claude-opus-5`) in the picker so that
// saved selections, presets and exports from before providers existed keep
// working; `openrouter:` is accepted as an explicit prefix too. OpenRouter's
// own ids can contain colons (`…:free`, `…:extended`), so only a prefix that
// names a known provider counts as one.

export const OPENROUTER_PROVIDER_ID = "openrouter";

export const KNOWN_PROVIDER_IDS = [
  OPENROUTER_PROVIDER_ID,
  "claude-cli",
  "codex-cli",
] as const;

export interface ParsedModelId {
  providerId: string;
  model: string;
}

export function parseModelId(
  fullId: string,
  knownProviders: readonly string[] = KNOWN_PROVIDER_IDS,
): ParsedModelId {
  const colon = fullId.indexOf(":");
  if (colon > 0) {
    const prefix = fullId.slice(0, colon);
    if (knownProviders.includes(prefix)) {
      return { providerId: prefix, model: fullId.slice(colon + 1) };
    }
  }
  return { providerId: OPENROUTER_PROVIDER_ID, model: fullId };
}

/** The id the picker and the debate API use for a provider-local model. */
export function pickerModelId(providerId: string, model: string): string {
  return providerId === OPENROUTER_PROVIDER_ID ? model : `${providerId}:${model}`;
}

/**
 * CLI model ids end up in argv (never a shell, but a leading "-" would still
 * be read as a flag), so they are restricted to a plain token.
 */
export const CLI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
