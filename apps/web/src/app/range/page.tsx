import type { Metadata } from "next";
import { RangeApp } from "@/components/range/RangeApp";

export const metadata: Metadata = {
  title: "The Range · Pursestrings",
  description:
    "A deliberately gullible AI agent guards testnet funds behind a Pursestrings policy. Talk it into anything; the contract decides.",
};

export default function RangePage() {
  return (
    <main>
      <RangeApp />
    </main>
  );
}
