import "refr/styles/globals.css";

import { type Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { TRPCReactProvider } from "refr/trpc/react";
import { get as getConfig } from "refr/server/services/config";

export const metadata: Metadata = {
  title: "refr",
  description: "Reference image manager",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { theme, accent, density } = getConfig();
  return (
    <html lang="en" data-theme={theme} data-accent={accent} data-density={density} className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
