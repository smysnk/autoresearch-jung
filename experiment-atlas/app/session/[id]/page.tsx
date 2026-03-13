import { notFound } from "next/navigation";

import { SessionExplorer } from "@/components/SessionExplorer";
import { getAllSessionIds, getSessionGraph } from "@/lib/atlas-data";

type SessionPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSessionIds().map((id) => ({ id }));
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { id } = await params;
  const session = getSessionGraph(id);

  if (!session) {
    notFound();
  }

  return <SessionExplorer session={session} initialMode="chronicle" />;
}
