/**
 * Regression tests — full-content message fingerprint.
 *
 * Plan.md (src/offload/index.ts _msgFingerprint): the fingerprint hashed
 * the role plus the FIRST 200 characters of content. Long tool results
 * routinely share their opening 200 characters — a JSON envelope, a log
 * preamble, a repeated header — so genuinely distinct messages produced
 * identical fingerprints and change detection concluded nothing moved.
 *
 * Fix: hash the full content (same approach as the canvas fingerprint fix —
 * a prefix is never a sound identity for data whose variation lives past the
 * prefix).
 *
 * Pre-fix this test fails: the messages below share a 200+ char prefix but
 * differ in the body, and the old fingerprint treats them as identical.
 */
import { describe, it, expect } from "vitest";
import { _testExports } from "./index.js";

const fp = _testExports._msgFingerprint;

describe("_msgFingerprint covers full message content", () => {
  it("two messages sharing a 200-char prefix but different bodies must produce different fingerprints", () => {
    const sharedPrefix = `{"status":"ok","header":"run-42","log":"${"l".repeat(220)}`; // >200 chars, identical
    const msgA = { role: "tool", content: sharedPrefix + `,"result":"AAAA"}` };
    const msgB = { role: "tool", content: sharedPrefix + `,"result":"BBBB"}` };

    // Sanity: the 200-char prefix actually is identical — the collision
    // precondition that defeats the old fingerprint.
    expect(msgA.content.slice(0, 200)).toBe(msgB.content.slice(0, 200));

    // The fix: full content differs, so fingerprints must differ.
    expect(fp(msgA)).not.toBe(fp(msgB));
  });

  it("identical messages still produce identical fingerprints (no false change detection)", () => {
    const body = "x".repeat(1000);
    const a = { role: "user", content: [{ type: "text", text: body }] };
    const b = { role: "user", content: [{ type: "text", text: body }] };
    expect(fp(a)).toBe(fp(b));
  });

  it("array content differing after char 200 produces different fingerprints", () => {
    const shared = "s".repeat(300);
    const a = { role: "assistant", content: [{ type: "text", text: shared + "A" }] };
    const b = { role: "assistant", content: [{ type: "text", text: shared + "B" }] };
    // Sanity: first 200 chars of the JSON-serialised array are identical.
    expect(JSON.stringify(a.content).slice(0, 200)).toBe(JSON.stringify(b.content).slice(0, 200));
    expect(fp(a)).not.toBe(fp(b));
  });

  it("role-only difference still produces different fingerprints", () => {
    const body = "same content";
    const a = { role: "user", content: body };
    const b = { role: "assistant", content: body };
    expect(fp(a)).not.toBe(fp(b));
  });

  it("message-shaped objects (msg.message.content) are hashed fully too", () => {
    const sharedPrefix = "p".repeat(250);
    const a = { type: "message", message: { role: "user", content: sharedPrefix + "tail-A" } };
    const b = { type: "message", message: { role: "user", content: sharedPrefix + "tail-B" } };
    expect(a.message.content.slice(0, 200)).toBe(b.message.content.slice(0, 200));
    expect(fp(a)).not.toBe(fp(b));
  });
});
