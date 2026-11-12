import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { HowItHolds } from "@/components/HowItHolds";
import { NothingToTrust } from "@/components/NothingToTrust";
import { OneBudget } from "@/components/OneBudget";
import { Problem } from "@/components/Problem";
import { RangeTeaser } from "@/components/RangeTeaser";
import { Verify } from "@/components/Verify";
import { WhatRuns } from "@/components/WhatRuns";

export default function Home() {
  return (
    <main>
      <Hero />
      <Problem />
      <WhatRuns />
      <HowItHolds />
      <OneBudget />
      <NothingToTrust />
      <RangeTeaser />
      <Verify />
      <Footer />
    </main>
  );
}
