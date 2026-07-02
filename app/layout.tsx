import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LLM Strategic Dilemma Lab",
  description: "Payoff-observability experiments with LLM strategic agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
