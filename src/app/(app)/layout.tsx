import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "refr/server/services/auth";
import { Rail } from "refr/app/_components/rail";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/login");
  return (
    // ponytail: flex-col-reverse puts the rail at the bottom on phones, left on tablet+ (flex-row)
    <div className="flex h-screen flex-col-reverse overflow-hidden sm:flex-row">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
