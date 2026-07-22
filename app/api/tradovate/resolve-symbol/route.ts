import { NextRequest, NextResponse } from "next/server";
import { findFrontMonthContract } from "@/lib/tradovate";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";
  const root = req.nextUrl.searchParams.get("root");

  if (!root) {
    return NextResponse.json({ error: "root is required (e.g. NQ or MNQ)" }, { status: 400 });
  }

  try {
    const result = await findFrontMonthContract(env, root);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}
