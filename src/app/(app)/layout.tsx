import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "refr/server/services/auth";
import { Rail } from "refr/app/_components/rail";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/login");
  return (
    <div className="flex h-screen overflow-hidden">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
