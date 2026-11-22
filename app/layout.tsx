import type { Metadata } from "next";
import "./globals.css";
import EmojiAssist from "./emoji-assist";

export const metadata: Metadata = {
  title: "Clipflow — Stream control",
  description: "Manage your streamers, clipping preferences, and publishing workspace.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}<EmojiAssist /></body>
    </html>
  );
}
