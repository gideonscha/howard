import { AutoRefresh } from "@/app/run/refresh";
import { ActivityFeed } from "./feed";

export const dynamic = "force-dynamic";

// Live system feed: what Howard is doing right now + everything he's done.
export default function ActivityPage() {
  return (
    <>
      <AutoRefresh seconds={5} />
      <h1>Activity</h1>
      <ActivityFeed limit={100} />
    </>
  );
}
