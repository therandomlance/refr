"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "refr/trpc/react";
import { useRouter } from "next/navigation";
import { BrandMark, Icon, type IconName } from "./icon";

const items: { href: string; label: string; icon: IconName }[] = [
  { href: "/search", label: "Search", icon: "search" },
  { href: "/browse", label: "Browse", icon: "folder" },
  { href: "/tagging", label: "Tagging", icon: "tag" },
  { href: "/queue", label: "Queue", icon: "queue" },
  { href: "/sessions", label: "Sessions", icon: "clock" },
  { href: "/palettes", label: "Palettes", icon: "palette" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export function Rail() {
  const pathname = usePathname();
  const router = useRouter();
  const authed = api.auth.status.useQuery();
  return (
    <nav className="rail" aria-label="Main">
      <div className="logo"><BrandMark /></div>
      {items.map((it) => (
        <Link key={it.href} href={it.href}
          className={`rail-btn ${pathname.startsWith(it.href) ? "active" : ""}`}
          data-label={it.label}
          aria-label={it.label}
          aria-current={pathname.startsWith(it.href) ? "page" : undefined}
        >
          <Icon name={it.icon} size={21} />
        </Link>
      ))}
      <div className="flex-1" />
      {authed.data && !authed.data.open && (
        <button
          className="rail-btn"
          data-label="Log out"
          aria-label="Log out"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.push("/login");
            router.refresh();
          }}
        >
          <Icon name="logout" size={20} />
        </button>
      )}
    </nav>
  );
}
