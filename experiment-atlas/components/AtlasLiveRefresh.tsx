"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";

const REFRESH_DEBOUNCE_MS = 250;
const RECONNECT_DELAY_MS = 1000;

export function AtlasLiveRefresh() {
  const router = useRouter();
  const refreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const queueRefresh = () => {
      if (refreshTimerRef.current !== null) {
        return;
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        startTransition(() => {
          router.refresh();
        });
      }, REFRESH_DEBOUNCE_MS);
    };

    let socket: WebSocket | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/live/ws`);
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string };
          if (payload.type === "disk-change") {
            queueRefresh();
          }
        } catch {
          return;
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      socket?.close();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [router]);

  return null;
}
