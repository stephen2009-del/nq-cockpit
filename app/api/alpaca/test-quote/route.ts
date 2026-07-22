import { NextRequest, NextResponse } from "next/server";
import { getQuote } from "@/lib/alpaca";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") || "QQQ";
  try {
    const result = await getQuote(symbol);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
