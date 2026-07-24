import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

// These two groups don't go through the login check:
// - Cron endpoints are hit by external services (cron-job.org), not a
//   browser — they can't supply a login. Already protected by their own
//   `?key=CRON_SECRET` check inside the route itself.
// - The login page and its API route obviously can't require you to
//   already be logged in to reach them, or nobody could ever log in.
const CRON_BYPASS_PATHS = ["/api/cron/daily-report", "/api/tradovate/stop-rules/check", "/api/schwab/auto-log", "/api/alpaca/auto-log"];
const AUTH_BYPASS_PATHS = ["/login", "/api/auth/login"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (CRON_BYPASS_PATHS.some((path) => pathname === path)) {
    return NextResponse.next();
  }
  if (AUTH_BYPASS_PATHS.some((path) => pathname === path)) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  const user = process.env.APP_USERNAME;
  const pass = process.env.APP_PASSWORD;

  // If credentials aren't configured, fail closed (block everything) rather
  // than silently leaving the app open.
  if (!secret || !user || !pass) {
    return new NextResponse("App is not configured with APP_USERNAME / APP_PASSWORD / SESSION_SECRET.", { status: 503 });
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const valid = await verifySessionToken(token, secret);

  if (valid) {
    return NextResponse.next();
  }

  // API requests get a plain 401 (a fetch() call can't follow a redirect
  // into an HTML login page usefully) — page navigations get redirected to
  // the actual login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico|favicon-32.png|apple-touch-icon.png|icon-192.png|icon-512.png|manifest.json|vendor).*)",
};
