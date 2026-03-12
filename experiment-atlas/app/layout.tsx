import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Experiment Atlas",
  description: "A visual explorer for autoresearch experiment sessions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="atlas-body">
        <div className="atlas-backdrop" />
        {children}
      </body>
    </html>
  );
}
