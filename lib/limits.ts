// Per-document character cap applied when inlining source documents into
// prompts. Longer documents are truncated and flagged in the UI.
export const MAX_DOCUMENT_CHARS = 150_000;

export function truncateDocumentContent(content: string): string {
  if (content.length <= MAX_DOCUMENT_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_DOCUMENT_CHARS)}\n\n[Document truncated at ${MAX_DOCUMENT_CHARS.toLocaleString()} characters]`;
}
