import { NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/schwab";

export async function GET() {
  try {
    const url = getAuthorizationUrl();
    return NextResponse.redirect(url);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
