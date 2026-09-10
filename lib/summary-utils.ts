export function pickDefaultSummaryModel(modelIds: string[]): string {
  const google = modelIds.find((id) => /google\//.test(id));
  if (google) {
    return google;
  }
  const gemini = modelIds.find((id) => /gemini/i.test(id));
  if (gemini) {
    return gemini;
  }
  return modelIds[0] ?? "";
}
