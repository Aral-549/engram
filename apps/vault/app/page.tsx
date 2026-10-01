"use client";
import { Dashboard } from "@/components/Dashboard";
import { Onboarding } from "@/components/Onboarding";
import { SessionProvider, useSession } from "@/components/SessionProvider";

function Vault() {
  const { status } = useSession();
  if (status === "ready") return <Dashboard />;
  return <Onboarding locked={status === "locked"} />;
}

export default function Page() {
  return (
    <SessionProvider>
      <Vault />
    </SessionProvider>
  );
}
