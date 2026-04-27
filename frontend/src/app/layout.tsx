import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "FlowPro",
  description: "Internal AI document cockpit"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

