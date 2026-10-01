import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import { persona } from "@/lib/personas";
import "./globals.css";

const display = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument-serif" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

const p = persona(process.env.NEXT_PUBLIC_AGENT_PERSONA);
export const metadata: Metadata = { title: `${p.name}, ${p.tagline.toLowerCase()}`, description: p.description };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} style={{ ["--color-seal" as string]: p.accent }}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
