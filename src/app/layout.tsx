import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { sendingEnabled } from "@/lib/env";

export const metadata: Metadata = {
  title: "Howard — Partner-Hunter",
  description: "Magic Portraits B2B2C outreach agent",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const live = sendingEnabled();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">
            <strong>Howard</strong> <span className="muted">partner-hunter</span>
          </div>
          <nav>
            <Link href="/metrics">Metrics</Link>
            <Link href="/queue">Queue</Link>
            <Link href="/pipeline">Pipeline</Link>
            <Link href="/samples">Samples</Link>
            <Link href="/performance">Performance</Link>
            <Link href="/health">Health</Link>
            <Link href="/activity">Activity</Link>
            <Link href="/run">Run</Link>
          </nav>
          <span className={live ? "pill pill-live" : "pill pill-dark"}>
            {live ? "SENDING LIVE" : "SENDING OFF"}
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
