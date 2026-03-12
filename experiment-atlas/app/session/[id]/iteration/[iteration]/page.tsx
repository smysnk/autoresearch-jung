import { notFound } from "next/navigation";

import { SessionExplorer } from "@/components/SessionExplorer";
import { getSessionGraph } from "@/lib/atlas-data";

type IterationPageProps = {
  params: Promise<{
    id: string;
    iteration: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function IterationPage({ params }: IterationPageProps) {
  const { id, iteration } = await params;
  const session = getSessionGraph(id);

  if (!session) {
    notFound();
  }

  return <SessionExplorer session={session} initialIterationLabel={iteration} initialMode="chronicle" />;
}
