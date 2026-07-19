import { NextRequest, NextResponse } from "next/server";

// These two endpoints are hit by external cron services (cron-job.org), not
// a browser — they can't supply a Basic Auth login. They're already
// protected by their own `?key=CRON_SECRET` check inside the route itself,
// so it's safe to let them skip the site-wide login here.
const CRON_BYPASS_PATHS = ["/api/cron/daily-report", "/api/tradovate/stop-rules/check"];

export function middleware(req: NextRequest) {
  if (CRON_BYPASS_PATHS.some((path) => req.nextUrl.pathname === path)) {
    return NextResponse.next();
  }

  const user = process.env.APP_USERNAME;
  const pass = process.env.APP_PASSWORD;

  // If credentials aren't configured, fail closed (block everything) rather
  // than silently leaving the app open.
  if (!user || !pass) {
    return new NextResponse("App is not configured with APP_USERNAME / APP_PASSWORD.", { status: 503 });
  }

  const auth = req.headers.get("authorization");

  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const separatorIndex = decoded.indexOf(":");
      const suppliedUser = decoded.slice(0, separatorIndex);
      const suppliedPass = decoded.slice(separatorIndex + 1);
      if (suppliedUser === user && suppliedPass === pass) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="NQ Cockpit"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
