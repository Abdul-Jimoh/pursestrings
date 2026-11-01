import { describe, expect, it } from "vitest";
import { describeDecision, explainDenial } from "./explain.ts";

describe("explainDenial", () => {
  it("names the shared budget and formats amounts", () => {
    const reason = { OverGroupWindow: { group: "usd", period_s: 86_400, remaining: "45000000" } };
    expect(explainDenial(reason, (a) => `$${Number(a) / 1e6}`)).toBe(
      'Over the shared "usd" budget per day; $45 left across every chain in it.',
    );
  });

  it("covers every unit reason", () => {
    for (const r of ["Frozen", "RecipientNotAllowed", "IntentsKeyMissing"] as const) {
      expect(explainDenial(r)).toMatch(/\.$/);
    }
  });

  it("describes decisions", () => {
    expect(describeDecision({ NeedsCosign: { req_id: 3, expires_at: 0 } })).toBe(
      "waiting for the owner's co-sign (request 3)",
    );
  });
});
