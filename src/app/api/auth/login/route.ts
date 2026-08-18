import { NextResponse } from "next/server";
import { createSession, isOpen, verifyPassword, SESSION_COOKIE } from "refr/server/services/auth";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  if (!isOpen() && !verifyPassword(body?.password ?? "")) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const session = createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    expires: session.expires,
    path: "/",
  });
  return res;
}
