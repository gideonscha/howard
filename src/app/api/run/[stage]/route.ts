import { NextRequest, NextResponse } from "next/server";
import { runDiscover } from "@/pipeline/discover";
import { runEnrich } from "@/pipeline/enrich";
import { runScore } from "@/pipeline/score";
import { runDraft } from "@/pipeline/draft";
import { runSend } from "@/pipeline/send";
import { runFollowup } from "@/pipeline/followup";
import { runSign } from "@/pipeline/sign";
import { runAttribute } from "@/pipeline/attribute";

export const maxDuration = 300;

// Manual stage trigger, e.g.:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<app>/api/run/discover?source=iaopcc"
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ stage: string }> }
) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { stage } = await params;
  const url = new URL(req.url);
  try {
    switch (stage) {
      case "discover":
        return NextResponse.json(await runDiscover(url.searchParams.get("source") ?? undefined));
      case "enrich":
        return NextResponse.json(await runEnrich(Number(url.searchParams.get("limit") ?? 10)));
      case "score":
        return NextResponse.json(await runScore());
      case "draft":
        return NextResponse.json(await runDraft(Number(url.searchParams.get("limit") ?? 5)));
      case "send":
        return NextResponse.json(await runSend());
      case "followup":
        return NextResponse.json(await runFollowup());
      case "attribute":
        return NextResponse.json(await runAttribute());
      case "sign": {
        const partnerId = url.searchParams.get("partner_id");
        if (!partnerId) return new NextResponse("partner_id required", { status: 400 });
        const pct = Number(url.searchParams.get("percentage") ?? 10);
        return NextResponse.json(await runSign(partnerId, pct));
      }
      default:
        return new NextResponse(`Unknown stage: ${stage}`, { status: 404 });
    }
  } catch (e) {
    console.error(`run/${stage} failed:`, e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
