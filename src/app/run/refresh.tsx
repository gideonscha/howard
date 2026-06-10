"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the /run server component every few seconds so background-run
// progress and results appear without a manual reload.
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
