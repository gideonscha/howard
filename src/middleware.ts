import { NextRequest, NextResponse } from "next/server";

// HTTP Basic auth for the dashboard. API routes manage their own auth:
//  - /api/cron/* and /api/run/*  → Bearer CRON_SECRET
//  - /api/webhooks/*             → Svix signature
//  - /api/u/*                    → HMAC token in the URL (must stay public)
//  - /c/*                        → wrapped CTA click redirect (must stay public)
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/") || pathname.startsWith("/c/")) return NextResponse.next();

  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) {
    return new NextResponse("Dashboard auth not configured (set DASHBOARD_USER / DASHBOARD_PASSWORD)", {
      status: 503,
    });
  }

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const [u, p] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (u === user && p === pass) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="partner-hunter"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
