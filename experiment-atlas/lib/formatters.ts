export function formatDateTime(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatMetric(value: number | null, digits = 4): string {
  if (value === null) {
    return "n/a";
  }
  return value.toFixed(digits);
}

export function formatMemoryGb(valueMb: number | null): string {
  if (valueMb === null) {
    return "n/a";
  }
  return `${(valueMb / 1024).toFixed(1)} GB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "n/a";
  }

  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  return `${Math.round(seconds)}s`;
}

export function formatPercent(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(1)}%`;
}

export function formatCompactNumber(value: number | null, digits = 1): string {
  if (value === null) {
    return "n/a";
  }
  return value.toFixed(digits);
}

export function titleCase(value: string | null, fallback = "Unknown"): string {
  if (!value) {
    return fallback;
  }
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function truncateText(value: string | null, limit = 120): string {
  if (!value) {
    return "No detail captured.";
  }
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
}

export function outcomeTone(value: string | null): string {
  switch (value) {
    case "confirmed":
    case "keep":
      return "tone-keep";
    case "contradicted":
    case "discard":
      return "tone-discard";
    case "mixed":
      return "tone-mixed";
    case "crash":
      return "tone-crash";
    default:
      return "tone-neutral";
  }
}
