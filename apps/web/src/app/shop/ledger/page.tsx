import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Ledger } from "@/components/shop/Ledger";

export const metadata: Metadata = {
  title: "The ledger · Check before you pay · Pursestrings",
  description:
    "Every order the shop's agent has quoted, delivered or refunded, read from NEAR testnet.",
};

export default function LedgerPage() {
  return (
    <main>
      <Ledger />
      <Footer />
    </main>
  );
}
