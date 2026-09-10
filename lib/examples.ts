import type { DebateMode, Stance } from "./types";

export type ExampleDocumentSource =
  | { kind: "url"; url: string }
  | { kind: "pdf"; path: string }
  | { kind: "text"; content: string };

export interface ExampleDocument {
  label: string;
  source: ExampleDocumentSource;
}

export interface DebateExample {
  id: string;
  title: string;
  description: string;
  contextBrief: string;
  mode: DebateMode;
  stances?: Stance[];
  documents: ExampleDocument[];
}

export interface ExamplesIndex {
  examples: DebateExample[];
}
