import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "./auth";

/** For route handlers — true when the request carries a valid session (or app is open). */
export async function requestAuthed(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}
