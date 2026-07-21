import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/schwab";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "No authorization code in callback URL. Check the raw URL and send it if this looks wrong." }, { status: 400 });
  }

  try {
    await exchangeCodeForTokens(code);
    return NextResponse.json({ ok: true, message: "Schwab connected successfully. Tokens stored." });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
