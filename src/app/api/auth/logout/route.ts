import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "refr/server/services/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, expires: new Date(0), path: "/" });
  return res;
}
