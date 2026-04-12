/**
 * Tests for renderPaperclipWakePrompt and normalizePaperclipWakePayload.
 *
 * Covers bugs found in production:
 * - Plugin session messages ({ prompt: "..." }) were dropped because
 *   normalizePaperclipWakePayload only looked for comments/commentIds
 * - Signal message text never reached the agent
 */
import { describe, it, expect } from "vitest";
import {
  renderPaperclipWakePrompt,
  normalizePaperclipWakePayload,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";

// ---------------------------------------------------------------------------
// normalizePaperclipWakePayload
// ---------------------------------------------------------------------------

describe("normalizePaperclipWakePayload", () => {
  it("returns null for empty object", () => {
    expect(normalizePaperclipWakePayload({})).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizePaperclipWakePayload(undefined)).toBeNull();
  });

  it("returns null for object with only prompt (no comments)", () => {
    // This is the Signal plugin session message format
    expect(normalizePaperclipWakePayload({ prompt: "Hello world" })).toBeNull();
  });

  it("returns payload when comments exist", () => {
    const result = normalizePaperclipWakePayload({
      reason: "new comment",
      comments: [
        {
          id: "comment-1",
          body: "Please check this",
          createdAt: "2026-04-07T00:00:00Z",
          authorType: "user",
          authorId: "user-1",
        },
      ],
      issue: { id: "issue-1", identifier: "PAX-42", title: "Fix the bug" },
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("new comment");
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0]!.body).toBe("Please check this");
  });

  it("returns payload when commentIds exist", () => {
    const result = normalizePaperclipWakePayload({
      commentIds: ["comment-1", "comment-2"],
    });
    expect(result).not.toBeNull();
    expect(result!.commentIds).toEqual(["comment-1", "comment-2"]);
  });

  it("filters empty strings from commentIds", () => {
    const result = normalizePaperclipWakePayload({
      commentIds: ["comment-1", "", "  ", "comment-2"],
    });
    expect(result).not.toBeNull();
    expect(result!.commentIds).toEqual(["comment-1", "comment-2"]);
  });

  it("returns null when comments array is empty and no commentIds", () => {
    expect(normalizePaperclipWakePayload({ comments: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderPaperclipWakePrompt
// ---------------------------------------------------------------------------

describe("renderPaperclipWakePrompt", () => {
  it("returns empty string for null/undefined input", () => {
    expect(renderPaperclipWakePrompt(null)).toBe("");
    expect(renderPaperclipWakePrompt(undefined)).toBe("");
  });

  it("returns empty string for empty object with no prompt", () => {
    expect(renderPaperclipWakePrompt({})).toBe("");
  });

  it("passes through plugin session prompt when no comments exist", () => {
    // THIS IS THE CRITICAL BUG FIX TEST
    // Signal plugin sends { prompt: "user message text" }
    // Previously this was dropped entirely, causing agents to never see Signal messages
    const result = renderPaperclipWakePrompt({
      prompt: "We need to set up failsafe watchdogs. Can you assign the CTOs to architect something?",
    });
    expect(result).toContain("failsafe watchdogs");
    expect(result).toContain("assign the CTOs");
    expect(result.length).toBeGreaterThan(50);
  });

  it("passes through prompt with conversation context", () => {
    const result = renderPaperclipWakePrompt({
      prompt: "--- Recent conversation ---\n[User] Hello\n--- End ---\n\nNow respond to: What is the status?",
    });
    expect(result).toContain("What is the status?");
    expect(result).toContain("Recent conversation");
  });

  it("does not pass through empty prompt string", () => {
    expect(renderPaperclipWakePrompt({ prompt: "" })).toBe("");
    expect(renderPaperclipWakePrompt({ prompt: "   " })).toBe("");
  });

  it("prefers comment-based rendering when comments exist", () => {
    // When both prompt and comments exist, comments format takes precedence
    const result = renderPaperclipWakePrompt({
      prompt: "This should not appear",
      comments: [
        {
          id: "c1",
          body: "Please review this PR",
          createdAt: "2026-04-07T00:00:00Z",
          authorType: "user",
        },
      ],
      issue: { id: "i1", identifier: "PAX-10" },
    });
    expect(result).toContain("Please review this PR");
    expect(result).toContain("Paperclip Wake Payload");
    // The direct prompt should NOT appear since comments are present
    expect(result).not.toContain("This should not appear");
  });

  it("renders non-resumed session wake payload correctly", () => {
    const result = renderPaperclipWakePrompt({
      reason: "new_comment",
      comments: [
        {
          id: "c1",
          body: "Build is broken",
          createdAt: "2026-04-07T00:00:00Z",
          authorType: "agent",
          authorId: "agent-cto",
        },
      ],
      issue: { id: "i1", identifier: "PAX-42", title: "Fix CI", status: "in_progress", priority: "high" },
    });
    expect(result).toContain("Paperclip Wake Payload");
    expect(result).toContain("reason: new_comment");
    expect(result).toContain("PAX-42");
    expect(result).toContain("Fix CI");
    expect(result).toContain("Build is broken");
    expect(result).toContain("issue status: in_progress");
    expect(result).toContain("issue priority: high");
  });

  it("renders resumed session delta correctly", () => {
    const result = renderPaperclipWakePrompt(
      {
        reason: "new_comment",
        comments: [
          { id: "c2", body: "Done with the fix", createdAt: "2026-04-07T01:00:00Z", authorType: "agent" },
        ],
        issue: { id: "i1", identifier: "PAX-42" },
      },
      { resumedSession: true },
    );
    expect(result).toContain("Paperclip Resume Delta");
    expect(result).toContain("resuming an existing Paperclip session");
    expect(result).toContain("Done with the fix");
  });
});

// ---------------------------------------------------------------------------
// stringifyPaperclipWakePayload
// ---------------------------------------------------------------------------

describe("stringifyPaperclipWakePayload", () => {
  it("returns null for plugin session messages (no comments)", () => {
    // Plugin prompt-only payloads don't have a normalizable structure
    expect(stringifyPaperclipWakePayload({ prompt: "Hello" })).toBeNull();
  });

  it("returns JSON string for valid comment payloads", () => {
    const result = stringifyPaperclipWakePayload({
      comments: [{ id: "c1", body: "test" }],
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.comments).toHaveLength(1);
  });
});
