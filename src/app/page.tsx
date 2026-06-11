import { redirect } from "next/navigation";

// Metrics is the dashboard's landing page; the action queue lives at /queue.
export default function Home() {
  redirect("/metrics");
}
