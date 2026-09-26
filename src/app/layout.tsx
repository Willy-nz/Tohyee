import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Toeyee",
  description: "Self-hosted accounting for New Zealand organisations",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-NZ">
      <body>{children}</body>
    </html>
  );
}
