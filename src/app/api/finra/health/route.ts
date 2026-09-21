import { NextResponse } from "next/server";
import { graphFileExists } from "@/lib/graphStore";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    graphExists: await graphFileExists(),
    timestamp: new Date().toISOString(),
  });
}
