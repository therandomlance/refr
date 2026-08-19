import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "refr/server/services/auth";
import { Rail } from "refr/app/_components/rail";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/login");
  return (
    // ponytail: on phones the rail is position:fixed (bottom bar) so it's decoupled
    // from this flex flow entirely — avoids the column-reverse sizing issues that
    // made the rail content vanish. .app-content gets padding-bottom on mobile to
    // clear the fixed bar. min-h-0 is still load-bearing for the virtualizer height.
    <div className="flex h-screen overflow-hidden">
      <Rail />
      <div className="app-content flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
