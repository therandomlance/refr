"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "refr/app/_components/icon";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const router = useRouter();

  return (
    <div className="login-screen">
      <form
        className="login-card"
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
        <div className="mb-3 flex flex-col items-center gap-3 text-center">
          <div className="brand-mark" style={{ width: 48, height: 48 }}><BrandMark size={26} /></div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">refr</h1>
            <p className="text-[13px] text-fg-subtle">Sign in to your reference library</p>
          </div>
        </div>
        <input
          type="password"
          className="input"
          placeholder="Password"
          autoFocus
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(false); }}
          aria-invalid={error}
        />
        {error && <p className="text-[13px] text-danger" role="alert">Wrong password</p>}
        <button className="btn primary" type="submit">Log in</button>
      </form>
    </div>
  );
}
