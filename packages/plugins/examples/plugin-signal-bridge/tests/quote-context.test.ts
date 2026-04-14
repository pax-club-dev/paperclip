import { describe, expect, it } from "vitest";
import { formatQuoteContext } from "../src/quote-context.js";

describe("formatQuoteContext", () => {
  it("returns formatted string with masked author and truncated text for valid quote", () => {
    const result = formatQuoteContext({
      text: "Let me check on the flight options for you",
      author: "+14155551234",
      id: 1713800000000, // Signal timestamp (ms)
    });

    expect(result).toContain("***1234");
    expect(result).toContain("Let me check on the flight options for you");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty string when quote is undefined", () => {
    expect(formatQuoteContext(undefined)).toBe("");
  });

  it("returns empty string when quote is null", () => {
    expect(formatQuoteContext(null)).toBe("");
  });

  it("returns empty string when quote.text is empty", () => {
    expect(
      formatQuoteContext({ text: "", author: "+14155551234", id: 1713800000000 }),
    ).toBe("");
  });

  it("returns empty string when quote.text is missing", () => {
    expect(
      formatQuoteContext({ author: "+14155551234", id: 1713800000000 }),
    ).toBe("");
  });

  it("truncates quote.text at 200 chars with ellipsis suffix", () => {
    const longText = "A".repeat(250);
    const result = formatQuoteContext({
      text: longText,
      author: "+14155551234",
      id: 1713800000000,
    });

    const truncated = "A".repeat(200) + "...";
    expect(result).toContain(truncated);
    expect(result).not.toContain("A".repeat(201));
  });

  it("does not truncate text that is exactly 200 chars", () => {
    const exactText = "B".repeat(200);
    const result = formatQuoteContext({
      text: exactText,
      author: "+14155551234",
      id: 1713800000000,
    });

    expect(result).toContain(exactText);
    expect(result).not.toContain("...");
  });

  it("masks quote.author phone number showing only last 4 chars", () => {
    const result = formatQuoteContext({
      text: "hello",
      author: "+14155559876",
      id: 1713800000000,
    });

    expect(result).toContain("***9876");
    expect(result).not.toContain("+14155559876");
  });

  it("formats quote.id timestamp as human-readable time", () => {
    // 1713800000000 ms = some specific time — just verify it contains a time-like pattern
    const result = formatQuoteContext({
      text: "hello",
      author: "+14155551234",
      id: 1713800000000,
    });

    // Should contain a time format like "H:MM AM/PM" or "HH:MM"
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("handles quote with missing author gracefully", () => {
    const result = formatQuoteContext({
      text: "some quoted text",
      id: 1713800000000,
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("some quoted text");
    // Should use a fallback like "unknown" instead of crashing
    expect(result).toMatch(/unknown|Unknown/i);
  });

  it("handles quote with short author (<=4 chars) without masking", () => {
    const result = formatQuoteContext({
      text: "test",
      author: "bot",
      id: 1713800000000,
    });

    expect(result).toContain("bot");
  });
});

describe("handleSignalMessage quote integration", () => {
  // These tests validate expected behavior when PAX-2315 implementation lands.
  // They require handleSignalMessage internals to be testable (exported or
  // refactored to accept dependencies). Marked with .todo until the
  // implementation provides the necessary test surface.

  it.todo(
    "when payload includes quote, agent prompt starts with formatted quote context",
  );

  it.todo(
    "when payload has no quote, agent prompt is just the raw message (backward compat)",
  );

  it.todo(
    "persistSignalMessage call includes quoteText and quoteAuthor when quote is present",
  );
});
