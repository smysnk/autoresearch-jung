import { SessionGallery } from "@/components/SessionGallery";
import { getAllSessions } from "@/lib/atlas-data";

export default function HomePage() {
  const sessions = getAllSessions();
  return <SessionGallery sessions={sessions} />;
}
