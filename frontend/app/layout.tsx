import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payment Service Demo",
  description: "Demo frontend for the Payment Processing Microservice",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
