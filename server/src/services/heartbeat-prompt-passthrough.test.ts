/**
 * Tests for Signal/plugin prompt passthrough in the heartbeat pipeline.
 *
 * Covers the bug where Signal message text was lost because:
 * 1. enrichWakeContextSnapshot ignored payload.prompt
 * 2. buildPaperclipWakePayload returned null (no comments) → paperclipWake deleted
 * 3. Adapter received no prompt → agent saw only a hyphen
 *
 * The fix stores payload.prompt in contextSnapshot and creates a minimal
 * { prompt: "..." } wake payload when no comments exist.
 */
import { describe, it, expect } from "vitest";
import { mergeCoalescedContextSnapshot } from "./heartbeat.js";
import {
  renderPaperclipWakePrompt,
  normalizePaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// mergeCoalescedContextSnapshot – prompt preservation
// ---------------------------------------------------------------------------

describe("mergeCoalescedContextSnapshot – prompt field", () => {
  it("preserves prompt from existing snapshot when incoming has none", () => {
    const merged = mergeCoalescedContextSnapshot(
      { prompt: "Hello from Signal", wakeSource: "automation" },
      { wakeTriggerDetail: "system" },
    );
    expect(merged.prompt).toBe("Hello from Signal");
  });

  it("incoming prompt overwrites existing prompt", () => {
    const merged = mergeCoalescedContextSnapshot(
      { prompt: "Old message" },
      { prompt: "New message" },
    );
    expect(merged.prompt).toBe("New message");
  });

  it("preserves prompt when no comment ids are present", () => {
    const merged = mergeCoalescedContextSnapshot(
      { prompt: "Signal message text", taskKey: "plugin:signal:session:abc" },
      { wakeSource: "automation" },
    );
    expect(merged.prompt).toBe("Signal message text");
    // No paperclipWake should be set by merge (that happens at execution time)
  });

  it("preserves prompt even when comment ids cause paperclipWake deletion", () => {
    // When comments are merged, paperclipWake is deleted but prompt should survive
    const merged = mergeCoalescedContextSnapshot(
      { prompt: "Signal message", wakeCommentIds: ["c1"] },
      { wakeCommentIds: ["c2"] },
    );
    expect(merged.prompt).toBe("Signal message");
    // Comment ids should be merged
    expect(merged.wakeCommentIds).toEqual(["c1", "c2"]);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline simulation: payload → contextSnapshot → paperclipWake → prompt
// ---------------------------------------------------------------------------

describe("plugin prompt passthrough – full pipeline", () => {
  /**
   * Simulates what enrichWakeContextSnapshot does with payload.prompt,
   * then what executeRun does to build paperclipWake from the contextSnapshot.
   */
  function simulateHeartbeatPipeline(payload: Record<string, unknown> | null) {
    // Step 1: enrichWakeContextSnapshot stores payload.prompt in contextSnapshot
    const contextSnapshot: Record<string, unknown> = {
      taskKey: "plugin:signal:session:abc",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
    };
    const prompt = payload?.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      contextSnapshot.prompt = prompt;
    }

    // Step 2: buildPaperclipWakePayload returns null (no comment IDs)
    const paperclipWakePayload = null; // No comments for Signal messages

    // Step 3: executeRun checks for direct prompt when no wake payload
    let paperclipWake: Record<string, unknown> | null = null;
    if (paperclipWakePayload) {
      paperclipWake = paperclipWakePayload;
    } else {
      const directPrompt = typeof contextSnapshot.prompt === "string"
        && contextSnapshot.prompt.trim().length > 0
        ? contextSnapshot.prompt as string
        : null;
      if (directPrompt) {
        paperclipWake = { prompt: directPrompt };
      }
    }

    // Step 4: Adapter calls renderPaperclipWakePrompt(context.paperclipWake)
    const renderedPrompt = renderPaperclipWakePrompt(paperclipWake);

    return { contextSnapshot, paperclipWake, renderedPrompt };
  }

  it("full 217-char Signal message reaches the adapter prompt", () => {
    const signalMessage = "We need to set up some sort of failsafe watch dogs. Can you assign the CTOs to architect and then implement something that makes sure the system never goes down and is self healing. That you'll bring yourself back up?";
    expect(signalMessage.length).toBe(217);

    const { renderedPrompt } = simulateHeartbeatPipeline({ prompt: signalMessage });

    expect(renderedPrompt).toBe(signalMessage);
    expect(renderedPrompt.length).toBe(217);
  });

  it("short Signal message reaches the adapter", () => {
    const { renderedPrompt } = simulateHeartbeatPipeline({ prompt: "Hello" });
    expect(renderedPrompt).toBe("Hello");
  });

  it("message with conversation context reaches the adapter", () => {
    const fullPrompt = "--- Recent conversation ---\n[User] Previous msg\n--- End ---\n\nWhat is the status?";
    const { renderedPrompt } = simulateHeartbeatPipeline({ prompt: fullPrompt });
    expect(renderedPrompt).toContain("What is the status?");
    expect(renderedPrompt).toContain("Recent conversation");
  });

  it("empty prompt does not create a wake payload", () => {
    const { paperclipWake, renderedPrompt } = simulateHeartbeatPipeline({ prompt: "" });
    expect(paperclipWake).toBeNull();
    expect(renderedPrompt).toBe("");
  });

  it("whitespace-only prompt does not create a wake payload", () => {
    const { paperclipWake, renderedPrompt } = simulateHeartbeatPipeline({ prompt: "   " });
    expect(paperclipWake).toBeNull();
    expect(renderedPrompt).toBe("");
  });

  it("null payload does not create a wake payload", () => {
    const { paperclipWake, renderedPrompt } = simulateHeartbeatPipeline(null);
    expect(paperclipWake).toBeNull();
    expect(renderedPrompt).toBe("");
  });

  it("payload without prompt field does not create a wake payload", () => {
    const { paperclipWake, renderedPrompt } = simulateHeartbeatPipeline({ issueId: "i1" });
    expect(paperclipWake).toBeNull();
    expect(renderedPrompt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderPaperclipWakePrompt – { prompt: "..." } payloads
// ---------------------------------------------------------------------------

describe("renderPaperclipWakePrompt with prompt-only payloads", () => {
  it("renders prompt-only payload (the Signal plugin format)", () => {
    const result = renderPaperclipWakePrompt({ prompt: "Check the build status" });
    expect(result).toBe("Check the build status");
  });

  it("returns empty for prompt-only payload with empty string", () => {
    expect(renderPaperclipWakePrompt({ prompt: "" })).toBe("");
  });

  it("returns empty for prompt-only payload with whitespace", () => {
    expect(renderPaperclipWakePrompt({ prompt: "   " })).toBe("");
  });

  it("prefers comment-based rendering over prompt when both exist", () => {
    const result = renderPaperclipWakePrompt({
      prompt: "This should be ignored",
      comments: [
        {
          id: "c1",
          body: "Comment body",
          createdAt: "2026-04-07T00:00:00Z",
          authorType: "user",
        },
      ],
      issue: { id: "i1", identifier: "PAX-1" },
    });
    expect(result).toContain("Comment body");
    expect(result).not.toContain("This should be ignored");
  });
});

// ---------------------------------------------------------------------------
// normalizePaperclipWakePayload – prompt-only payloads return null
// ---------------------------------------------------------------------------

describe("normalizePaperclipWakePayload with prompt-only payloads", () => {
  it("returns null for prompt-only payload (no comments)", () => {
    // This is correct — the normalizer should return null for prompt-only,
    // and renderPaperclipWakePrompt handles the fallback
    expect(normalizePaperclipWakePayload({ prompt: "Hello" })).toBeNull();
  });

  it("returns payload when comments exist alongside prompt", () => {
    const result = normalizePaperclipWakePayload({
      prompt: "ignored",
      comments: [{ id: "c1", body: "test", createdAt: "2026-04-07T00:00:00Z", authorType: "user" }],
    });
    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(1);
  });
});
