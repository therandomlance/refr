"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const router = useRouter();

  return (
    <div className="grid h-screen place-items-center">
      <form
        className="flex w-72 flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password }),
          });
          if (res.ok) {
            router.push("/browse");
            router.refresh();
          } else {
            setError(true);
          }
        }}
      >
        <div className="mb-2 flex items-center gap-3">
          <div className="logo" style={{ width: 36, height: 36, borderRadius: "var(--radius)", background: "var(--accent)", color: "var(--accent-fg)", display: "grid", placeItems: "center", fontWeight: 700 }}>r</div>
          <h1 className="text-lg font-semibold">refr</h1>
        </div>
        <input
          type="password"
          className="input"
          placeholder="Password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm" style={{ color: "#e66" }}>Wrong password</p>}
        <button className="btn primary" type="submit">Log in</button>
      </form>
    </div>
  );
}
