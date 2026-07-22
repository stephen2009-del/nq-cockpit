import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccounts } from "@/lib/tradovate";
import { getTradingWindowStatus } from "@/lib/tradingWindow";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") || "demo") as "demo" | "live";

  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.settings.create({ data: { id: 1 } });
  }

  const windowStatus = getTradingWindowStatus(settings);

  try {
    const accountsResult = await getAccounts(env);
    return NextResponse.json({
      connected: accountsResult.ok,
      env,
      accounts: accountsResult.ok ? accountsResult.body : null,
      error: accountsResult.ok ? null : accountsResult.body,
      tradingWindow: windowStatus,
    });
  } catch (err: any) {
    return NextResponse.json({
      connected: false,
      env,
      accounts: null,
      error: err.message || String(err),
      tradingWindow: windowStatus,
    });
  }
}
