import { describe, expect, it } from "vitest";
import { describe as say, tightens } from "./ops";
import { fromRaw, type Policy, type Rule, toRaw } from "./policy";

const usdc = { Nep141: { token: "usdc.testnet" } };
const rule: Rule = {
  asset: usdc,
  per_tx_cap: "50000000",
  windows: [{ period_s: 86_400, limit: "100000000" }],
  cosign_above: "40000000",
  risk_check_above: null,
};
const policy: Policy = {
  version: 1,
  frozen: false,
  assets: [rule],
  recipients: [{ Near: { account: "shop.testnet" } }],
  chains: [],
  cooldown_s: 0,
  velocity: { max: 10, period_s: 3_600 },
  pending_ttl_s: 3_600,
  timelock_s: 3_600,
};
const set = (r: Partial<Rule>) => ({ SetAssetRule: { ...rule, ...r } });

describe("tightens, as the contract's classify", () => {
  it("lower caps and limits apply now", () => {
    expect(tightens(set({ per_tx_cap: "10000000" }), policy)).toBe(true);
    expect(tightens(set({ windows: [{ period_s: 86_400, limit: "1" }] }), policy)).toBe(true);
    expect(tightens(set({ cosign_above: "1" }), policy)).toBe(true);
  });

  it("anything looser waits", () => {
    expect(tightens(set({ per_tx_cap: "60000000" }), policy)).toBe(false);
    expect(tightens(set({ cosign_above: null }), policy)).toBe(false);
    expect(tightens(set({ windows: [] }), policy)).toBe(false);
    expect(tightens(set({ windows: [{ period_s: 3_600, limit: "1" }] }), policy)).toBe(false);
    expect(tightens({ SetAssetRule: { ...rule, asset: "Near" } }, policy)).toBe(false);
  });

  it("recipients, velocity and freezing", () => {
    const shop = { Near: { account: "shop.testnet" } };
    expect(tightens({ RemoveRecipient: shop }, policy)).toBe(true);
    expect(tightens({ AddRecipient: shop }, policy)).toBe(false);
    expect(tightens({ SetVelocity: { velocity: { max: 5, period_s: 3_600 } } }, policy)).toBe(true);
    expect(tightens({ SetVelocity: { velocity: { max: 5, period_s: 60 } } }, policy)).toBe(false);
    expect(tightens({ SetVelocity: { velocity: null } }, policy)).toBe(false);
    expect(tightens("Freeze", policy)).toBe(true);
    expect(tightens("Unfreeze", policy)).toBe(false);
    expect(tightens({ RemoveGroup: { name: "usd" } }, policy)).toBe(false);
  });

  it("shop and board rules", () => {
    const p = {
      ...policy,
      floors: [{ asset: "Near" as const, min: "50" }],
      split: [{ account: "dao.testnet", bps: 2_000 }],
      delivery_s: 600,
    };
    expect(tightens({ SetPriceFloor: { asset: "Near", min: "60" } }, p)).toBe(true);
    expect(tightens({ SetPriceFloor: { asset: "Near", min: "40" } }, p)).toBe(false);
    expect(tightens({ SetSplit: { shares: p.split } }, p)).toBe(true);
    expect(tightens({ SetSplit: { shares: [{ account: "me.testnet", bps: 2_000 }] } }, p)).toBe(
      false,
    );
    expect(tightens({ SetDeliveryWindow: { seconds: 300 } }, p)).toBe(true);
    expect(tightens({ SetDeliveryWindow: { seconds: 900 } }, p)).toBe(false);
    expect(tightens({ RemoveCouncil: { account: "c.testnet" } }, p)).toBe(true);
    expect(tightens({ AddCouncil: { account: "c.testnet" } }, p)).toBe(false);
  });
});

describe("plain English", () => {
  it("reads each change back", () => {
    expect(say(set({ per_tx_cap: "25000000" }))).toBe(
      "usdc.testnet: largest payment 25 usdc.testnet, 100 usdc.testnet per day, co-sign above 40 usdc.testnet.",
    );
    expect(say({ AddRecipient: { Evm: { chain_id: 84532, address: "0xab" } } })).toBe(
      "Allow payments to 0xab on Base Sepolia.",
    );
    expect(say({ SetVelocity: { velocity: { max: 3, period_s: 3_600 } } })).toBe(
      "At most 3 payments per hour.",
    );
  });
});

describe("toRaw", () => {
  it("converts exactly and refuses what it can't represent", () => {
    expect(toRaw("12.5", 6)).toBe("12500000");
    expect(toRaw("0.000001", 6)).toBe("1");
    expect(toRaw("1", 24)).toBe(`1${"0".repeat(24)}`);
    expect(() => toRaw("0.0000001", 6)).toThrow();
    expect(() => toRaw("-1", 6)).toThrow();
    expect(() => toRaw("1e3", 6)).toThrow();
  });

  it("round-trips with fromRaw, so untouched fields never look changed", () => {
    for (const [raw, d] of [
      ["12500000", 6],
      ["1", 6],
      ["0", 6],
      ["300000000000000000000000", 24],
      ["7", 0],
    ] as const)
      expect(toRaw(fromRaw(raw, d), d)).toBe(raw);
    expect(fromRaw("12500000", 6)).toBe("12.5");
    expect(fromRaw("1", 6)).toBe("0.000001");
  });
});
