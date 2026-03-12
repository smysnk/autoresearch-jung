import { notFound } from "next/navigation";

import { SessionExplorer } from "@/components/SessionExplorer";
import { getSessionGraph } from "@/lib/atlas-data";

type ComparePageProps = {
  params: Promise<{
    id: string;
  }>;
  searchParams?: Promise<{
    tension?: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function ComparePage({ params, searchParams }: ComparePageProps) {
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const session = getSessionGraph(id);

  if (!session) {
    notFound();
  }

  return (
    <SessionExplorer
      session={session}
      focusTensionId={resolvedSearchParams?.tension}
      initialMode="mirror"
    />
  );
}
