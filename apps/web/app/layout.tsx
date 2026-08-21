import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DevMemoir",
  description: "A truthful record of work observed in connected repositories.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
