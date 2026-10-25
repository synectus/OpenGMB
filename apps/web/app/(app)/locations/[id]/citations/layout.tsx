import type { ReactNode } from "react";
import { ClientMessages } from "../../../../../components/client-messages";

export default function Layout({ children }: { children: ReactNode }) {
  return <ClientMessages set="locationMedia">{children}</ClientMessages>;
}
