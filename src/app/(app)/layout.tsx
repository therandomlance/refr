import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "refr/server/services/auth";
import { Rail } from "refr/app/_components/rail";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/login");
  return (
    // ponytail: flex-col-reverse puts the rail at the bottom on phones, left on tablet+ (flex-row).
    // min-h-0 on the content div is load-bearing: without it the column-reverse main-axis
    // item won't shrink below its content, the grid overflows, the virtualizer renders every
    // row at once, and the infinite-scroll trigger loops (rapid flashing + image thrash).
    <div className="flex h-screen flex-col-reverse overflow-hidden sm:flex-row">
      <Rail />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
