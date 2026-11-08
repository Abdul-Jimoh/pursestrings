import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { ShopApp } from "@/components/shop/ShopApp";

export const metadata: Metadata = {
  title: "Check before you pay · Pursestrings",
  description:
    "An AI agent sells plain-English checks on any NEAR account or 0x address. A Pursestrings contract holds the payment until delivery and splits it with the community.",
};

export default function ShopPage() {
  return (
    <main>
      <ShopApp />
      <Footer />
    </main>
  );
}
