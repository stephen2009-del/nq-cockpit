import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const username = body?.username;
  const password = body?.password;

  const user = process.env.APP_USERNAME;
  const pass = process.env.APP_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!user || !pass || !secret) {
    return NextResponse.json({ error: "Server is not configured (missing APP_USERNAME/APP_PASSWORD/SESSION_SECRET)." }, { status: 503 });
  }

  if (username !== user || password !== pass) {
    return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
  }

  const token = await createSessionToken(secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 90, // 90 days
    path: "/",
  });
  return res;
}
