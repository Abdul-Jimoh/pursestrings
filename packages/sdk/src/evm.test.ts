import { secp256k1 } from "@noble/curves/secp256k1.js";
import { baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { decodeSignedTx, evmAddress } from "./evm.ts";

describe("evm helpers", () => {
  it("derives the well-known address of private key 1", () => {
    const key = new Uint8Array(32);
    key[31] = 1;
    const xy = secp256k1.getPublicKey(key, false).slice(1);
    expect(evmAddress(`secp256k1:${baseEncode(xy)}`)).toBe(
      "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    );
  });

  it("rejects non-1559 transactions", () => {
    expect(() => decodeSignedTx("0xf86b")).toThrow("not an EIP-1559 transaction");
  });
});
