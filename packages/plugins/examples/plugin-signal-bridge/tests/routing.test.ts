import { describe, expect, it } from "vitest";
import { extractMentionTokens, resolveMentionedAgents } from "../src/routing.js";

const agents = [
  {
    id: "a-cmo",
    name: "PAX.CMO.BRAVO",
    urlKey: "pax-cmo",
    title: "CMO",
    role: "cmo",
  },
  {
    id: "a-cpo",
    name: "PAX.CPO.BRAVO",
    urlKey: "pax-cpo",
    title: "CPO",
    role: "cpo",
  },
  {
    id: "a-cto",
    name: "PAX.CTO.BRAVO",
    urlKey: "pax-cto",
    title: "CTO",
    role: "cto",
  },
] as any[];

describe("signal mention routing", () => {
  it("extracts @mentions even when suffixed with punctuation", () => {
    const tokens = extractMentionTokens("@CMO: can you own messaging economics?");
    expect(tokens).toContain("cmo");
  });

  it("maps explicit mention to the correct single agent", () => {
    const targets = resolveMentionedAgents(["cmo"], agents as any);
    expect(targets.map((target) => target.agentId)).toEqual(["a-cmo"]);
  });

  it("supports multiple mentioned agents in one message", () => {
    const targets = resolveMentionedAgents(["cmo", "cpo"], agents as any);
    expect(targets.map((target) => target.agentId)).toEqual(["a-cmo", "a-cpo"]);
  });

  it("does not route when mention cannot be resolved", () => {
    const targets = resolveMentionedAgents(["unknownagent"], agents as any);
    expect(targets).toEqual([]);
  });
});
