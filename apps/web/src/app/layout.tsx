import type { Metadata, Viewport } from "next";
import { Archivo, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import { SmoothScroll } from "@/components/SmoothScroll";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" });
const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
});
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Pursestrings: your agent holds the purse, you hold the strings",
  description:
    "One on-chain spending policy for an AI agent across NEAR, every EVM chain through Chain Signatures, and NEAR Intents. The agent can only ask; the contract builds and checks every payment itself.",
  metadataBase: new URL("https://www.pursestrings.site"),
  openGraph: {
    type: "website",
    siteName: "Pursestrings",
    title: "Pursestrings: your agent holds the purse, you hold the strings",
    description:
      "AI agent spending rules enforced by a NEAR contract: an agent-run shop and a DAO bounty board run on it, and the agent can only ask.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Pursestrings: your agent holds the purse, you hold the strings.",
      },
    ],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export const viewport: Viewport = { themeColor: "#0b0b0a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${instrument.variable} ${jetbrains.variable}`}>
      <head>
        <noscript>
          <style>{".reveal{visibility:visible}"}</style>
        </noscript>
      </head>
      {/* Extensions such as ColorZilla write attributes onto <body> before React hydrates. */}
      <body suppressHydrationWarning>
        <SmoothScroll />
        <Nav />
        {children}
      </body>
    </html>
  );
}
