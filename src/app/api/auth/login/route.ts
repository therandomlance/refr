import { NextResponse } from "next/server";
import { checkLogin, createSession, isOpen, SESSION_COOKIE } from "refr/server/services/auth";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  if (!isOpen()) {
    const check = checkLogin(body?.password ?? "");
    if (check === null) return NextResponse.json({ ok: false }, { status: 429 });
    if (!(await check)) return NextResponse.json({ ok: false }, { status: 401 });
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
