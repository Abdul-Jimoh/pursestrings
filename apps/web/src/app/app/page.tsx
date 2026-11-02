import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Dashboard · Pursestrings",
  description:
    "See what a Pursestrings account allows, spends and waits on. The owner approves co-signs, edits limits with a plain-English read-back and freezes everything in one transaction.",
};

export default function DashboardPage() {
  return (
    <main>
      <Dashboard />
      <Footer />
    </main>
  );
}
