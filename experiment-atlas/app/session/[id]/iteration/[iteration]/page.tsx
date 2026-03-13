import { notFound } from "next/navigation";

import { SessionExplorer } from "@/components/SessionExplorer";
import { getAllSessionIds, getIterationLabels, getSessionGraph } from "@/lib/atlas-data";

type IterationPageProps = {
  params: Promise<{
    id: string;
    iteration: string;
  }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSessionIds().flatMap((id) =>
    getIterationLabels(id).map((iteration) => ({
      id,
      iteration,
    })),
  );
}

export default async function IterationPage({ params }: IterationPageProps) {
  const { id, iteration } = await params;
  const session = getSessionGraph(id);

  if (!session) {
    notFound();
  }

  return <SessionExplorer session={session} initialIterationLabel={iteration} initialMode="chronicle" />;
}
