import { Suspense } from "react";
import { notFound } from "next/navigation";

import { CompareExplorer } from "@/components/CompareExplorer";
import { SessionExplorer } from "@/components/SessionExplorer";
import { getAllSessionIds, getSessionGraph } from "@/lib/atlas-data";

type ComparePageProps = {
  params: Promise<{
    id: string;
  }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSessionIds().map((id) => ({ id }));
}

export default async function ComparePage({ params }: ComparePageProps) {
  const { id } = await params;
  const session = getSessionGraph(id);

  if (!session) {
    notFound();
  }

  return (
    <Suspense fallback={<SessionExplorer session={session} initialMode="mirror" />}>
      <CompareExplorer session={session} />
    </Suspense>
  );
}
