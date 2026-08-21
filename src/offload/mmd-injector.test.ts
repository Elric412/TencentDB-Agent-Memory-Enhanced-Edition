/**
 * Regression tests — full-content canvas fingerprint.
 *
 * Plan.md (mmd-injector.ts computeFingerprint): the canvas fingerprint was
 * `${content.length}:${content.slice(0, 64)}` — byte length plus the first 64
 * characters. Mermaid canvases all start with the same header line and are
 * edited in the middle, so two genuinely different canvases with the same
 * length and the same opening 64 characters are not a contrived collision but
 * what a normal edit produces. When it collided, maybeUpdateMmdInMessages
 * concluded nothing changed and kept injecting the stale task state.
 *
 * Fix: hash the full content (the digest machinery already exists).
 *
 * Pre-fix this test fails: both canvases below share length and a 64-char
 * prefix but differ in the body, and the old fingerprint treats them as
 * identical — the injector would skip the update.
 */
import { describe, it, expect } from "vitest";
import { computeFingerprint } from "./mmd-injector.js";

describe("computeFingerprint covers the full canvas content", () => {
  it("same length + same 64-char prefix but different bodies → different fingerprints", () => {
    // Build two canvases that collide under the old
    // `${length}:${slice(0,64)}` scheme: identical length AND identical first
    // 64 characters, differing only in the middle.
    const header = "%%{init: {'theme': 'base'}}%%\ngraph TD\n  001-N1[\"start\"]\n  001-N2[\"next\"]\n"; // ≥64 chars
    expect(header.length).toBeGreaterThanOrEqual(64);

    const bodyA = "AAAA"; // divergent body
    const bodyB = "BBBB";
    const tail = "\"]\n  001-N1 --> 001-N2\n";

    // Pad the bodies so both canvases end up the same total length.
    const padA = "x".repeat(40);
    const padB = "y".repeat(40);

    const canvasA = header + bodyA + padA + tail;
    const canvasB = header + bodyB + padB + tail;

    // Sanity: the collision preconditions actually hold.
    expect(canvasA.length).toBe(canvasB.length);
    expect(canvasA.slice(0, 64)).toBe(canvasB.slice(0, 64));
    expect(canvasA).not.toBe(canvasB); // bodies genuinely differ

    // The injector must see them as different. Pre-fix this throws because
    // both fingerprints are `${len}:${samePrefix}` — identical.
    expect(computeFingerprint(canvasA)).not.toBe(computeFingerprint(canvasB));
  });

  it("identical content → identical fingerprint (no spurious updates)", () => {
    const canvas = "graph TD\n  001-N1[\"task\"]\n";
    expect(computeFingerprint(canvas)).toBe(computeFingerprint(canvas));
  });

  it("any single-character body change flips the fingerprint", () => {
    const base = "graph TD\n  001-N1[\"task state: working on auth\"]\n";
    const edited = base.replace("auth", "api");
    expect(computeFingerprint(base)).not.toBe(computeFingerprint(edited));
  });
});
