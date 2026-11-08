import type { Metadata } from "next";
import { BoardApp } from "@/components/board/BoardApp";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "The community board · Pursestrings",
  description:
    "Report lookalike addresses for bounties. An AI agent reviews each report, and the contract pays by earned trust: auto, one council member, or a DAO vote.",
};

export default function BountiesPage() {
  return (
    <main>
      <BoardApp />
      <Footer />
    </main>
  );
}
