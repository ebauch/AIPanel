import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DebateListItem } from "@/lib/debate-record";
import { formatRelative, RECENTS_LIMIT, selectRecents, shortModelName } from "@/lib/recents";

const NOW = new Date("2026-11-16T12:00:00Z");

function item(id: string, updatedAt: string, extra: Partial<DebateListItem> = {}): DebateListItem {
  return {
    id,
    title: `Debate ${id}`,
    createdAt: updatedAt,
    updatedAt,
    source: "web",
    status: "done",
    models: ["Claude Opus 5.5", "GPT-6 Astra"],
    turnCount: 4,
    ...extra,
  };
}

describe("selectRecents", () => {
  it("returns null (show examples) when there are no debates or the call failed", () => {
    assert.equal(selectRecents([], NOW), null);
    assert.equal(selectRecents(null, NOW), null);
    assert.equal(selectRecents(undefined, NOW), null);
  });

  it("shows recents once a single debate exists", () => {
    const recents = selectRecents([item("20261116-110000-aaaaaa", "2026-11-16T11:00:00Z")], NOW);
    assert.deepEqual(recents, [
      {
        id: "20261116-110000-aaaaaa",
        href: "/debates/20261116-110000-aaaaaa",
        title: "Debate 20261116-110000-aaaaaa",
        subline: "1 h ago · Opus 5.5, GPT-6 Astra · done",
      },
    ]);
  });

  it("orders newest first and caps at the limit", () => {
    const debates = Array.from({ length: 9 }, (_, i) =>
      item(`20261110-00000${i}-aaaaaa`, `2026-11-1${i % 7}T0${i}:00:00Z`),
    );
    const recents = selectRecents(debates, NOW)!;
    assert.equal(recents.length, RECENTS_LIMIT);
    const order = recents.map((card) => card.id);
    const expected = [...debates]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, RECENTS_LIMIT)
      .map((d) => d.id);
    assert.deepEqual(order, expected);
    assert.equal(selectRecents(debates, NOW, 2)!.length, 2);
  });

  it("labels error as failed and keeps running", () => {
    const [failed, running] = selectRecents(
      [
        item("20261116-115000-bbbbbb", "2026-11-16T11:50:00Z", { status: "error" }),
        item("20261116-114000-cccccc", "2026-11-16T11:40:00Z", { status: "running" }),
      ],
      NOW,
    )!;
    assert.match(failed.subline, / · failed$/);
    assert.match(running.subline, / · running$/);
  });
});

describe("formatRelative / shortModelName", () => {
  it("formats relative dates", () => {
    assert.equal(formatRelative("2026-11-16T11:59:40Z", NOW), "just now");
    assert.equal(formatRelative("2026-11-16T11:55:00Z", NOW), "5 min ago");
    assert.equal(formatRelative("2026-11-16T09:00:00Z", NOW), "3 h ago");
    assert.equal(formatRelative("2026-11-15T10:00:00Z", NOW), "yesterday");
    assert.equal(formatRelative("2026-11-12T12:00:00Z", NOW), "4 days ago");
    assert.equal(formatRelative("not a date", NOW), "");
  });

  it("shortens model display names", () => {
    assert.equal(shortModelName("Anthropic: Claude Fable 5"), "Fable 5");
    assert.equal(shortModelName("Claude Opus 5.5 (CLI)"), "Opus 5.5");
    assert.equal(shortModelName("GPT-6 Astra"), "GPT-6 Astra");
  });
});
