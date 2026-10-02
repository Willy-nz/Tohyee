import type { Metadata } from "next";
import "./globals.css";
import { ConfirmProvider } from "@/components/confirm-dialog";

export const metadata: Metadata = {
  title: "Tohyee",
  description: "Self-hosted accounting for New Zealand organisations",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-NZ">
      <body>
        <ConfirmProvider>{children}</ConfirmProvider>
      </body>
    </html>
  );
}
