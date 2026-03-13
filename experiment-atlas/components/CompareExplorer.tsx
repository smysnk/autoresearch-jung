"use client";

import { useSearchParams } from "next/navigation";

import { SessionExplorer } from "@/components/SessionExplorer";
import type { SessionGraph } from "@/lib/types";

export function CompareExplorer({ session }: { session: SessionGraph }) {
  const searchParams = useSearchParams();
  return (
    <SessionExplorer
      session={session}
      focusTensionId={searchParams.get("tension") ?? undefined}
      initialMode="mirror"
    />
  );
}
