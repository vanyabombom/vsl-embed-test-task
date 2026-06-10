import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VSL Player Test Task",
  description: "Self-hosted VSL player replacement for Vidalytics",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
