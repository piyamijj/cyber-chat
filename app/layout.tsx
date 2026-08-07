import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cyber Chat",
  description: "Cyber Chat — your AI assistant.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" style={{ backgroundColor: "#0b0e14" }}>
      <body style={{ backgroundColor: "#0b0e14" }}>{children}</body>
    </html>
  );
}