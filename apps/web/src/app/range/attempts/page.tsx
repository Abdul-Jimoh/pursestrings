import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { AllAttempts } from "@/components/range/AllAttempts";

export const metadata: Metadata = {
  title: "Every attempt · The Range · Pursestrings",
  description: "Every prompt sent to the Range agent, what it did, and what the contract decided.",
};

export default function AttemptsPage() {
  return (
    <main>
      <AllAttempts />
      <Footer />
    </main>
  );
}
