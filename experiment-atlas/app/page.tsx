import { SessionGallery } from "@/components/SessionGallery";
import { getAllSessions } from "@/lib/atlas-data";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const sessions = getAllSessions();
  return <SessionGallery sessions={sessions} />;
}
