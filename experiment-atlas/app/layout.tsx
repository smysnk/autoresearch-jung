import type { Metadata } from "next";
import { IBM_Plex_Mono, Orbitron, Space_Grotesk } from "next/font/google";

import { AtlasLiveRefresh } from "@/components/AtlasLiveRefresh";

import "./globals.css";

const displayFont = Orbitron({
  subsets: ["latin"],
  variable: "--atlas-font-display",
});

const bodyFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--atlas-font-body",
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--atlas-font-mono",
});

export const metadata: Metadata = {
  title: "Experiment Atlas | Dialectical Explorer",
  description: "A Jungian-tinged visual explorer for autoresearch experiment sessions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`atlas-body ${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}>
        <div className="atlas-backdrop" />
        <AtlasLiveRefresh />
        {children}
      </body>
    </html>
  );
}
