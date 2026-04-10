import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Prisoner's Dilemma — LLM Replication",
  description: "Replicating Flood (1958) with an LLM",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
