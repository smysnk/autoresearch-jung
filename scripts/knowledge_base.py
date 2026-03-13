#!/usr/bin/env python3
"""Build a distilled experiment knowledge base from canonical session logs."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
EXPERIMENT_LOGS_DIRNAME = "experiment_logs"
DEFAULT_KNOWLEDGE_DIRNAME = "knowledge_base"
CORROBORATION_SIGNAL_TOLERANCE = 0.0015
CORROBORATION_SOFT_TOLERANCE = 0.003
AXIS_ANCHOR_MAX_SIGNAL_DELTA = 0.0012
AXIS_ANCHOR_MAX_SCORE_DELTA = 0.0006


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
    path.write_text(payload)


def list_directories(path: Path) -> list[Path]:
    if not path.is_dir():
        return []
    return sorted((entry for entry in path.iterdir() if entry.is_dir()), key=lambda entry: entry.name)


def as_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return str(value)


def as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def relative_to_repo(repo_root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def snake_case(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def compact_text(value: str | None, *, limit: int = 220) -> str | None:
    if not value:
        return None
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "…"


def load_text(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text()


def inference_blob(*values: str | None) -> str:
    return "\n".join(value for value in values if value).lower()


TAG_PATTERNS: list[tuple[str, str]] = [
    (r"\bdepth\b|\blayer\b", "depth"),
    (r"\bwidth\b|\bffn\b", "width"),
    (r"\bbatch\b", "batch"),
    (r"\bwarmup\b", "warmup"),
    (r"\bcooldown\b", "cooldown"),
    (r"\blearning rate\b|\blr\b", "learning-rate"),
    (r"\bembedding\b", "embedding"),
    (r"\bcontext\b|\bwindow\b", "context"),
    (r"\battention\b", "attention"),
    (r"\boptimizer\b|\bmuon\b|\badamw\b", "optimizer"),
    (r"\brope\b", "rope"),
    (r"\bseed\b", "seed"),
    (r"\bthroughput\b", "throughput"),
    (r"\bstability\b", "stability"),
    (r"\bsimple|simplicity\b", "simplicity"),
    (r"\bnovel|novelty\b", "novelty"),
    (r"\bmemory\b|\bvram\b", "memory"),
    (r"\bquality\b|\bval_bpb\b|\bbpb\b", "quality"),
]


@dataclass
class TensionSummary:
    id: str
    label: str | None
    kind: str | None
    favored_side: str | None
    why_active: str | None


@dataclass
class IterationContext:
    record: dict[str, Any]
    value_bpb: float | None


@dataclass(frozen=True)
class TensionPair:
    session_id: str
    iteration: int
    iteration_label: str
    experiment_id: str
    anchor_experiment_id: str | None
    opposing_experiment_id: str | None
    selection_reason: str
    shared_axes: list[str]
    opposed_axes: list[str]
    relevance_score: float
    opposition_score: float
    total_score: float
    transcendent_prediction: str | None


def confidence_weight(value: str | None) -> float:
    mapping = {
        "strong": 1.0,
        "moderate": 0.82,
        "weak": 0.56,
        "confounded": 0.28,
        "seed-sensitive": 0.4,
        "failed": 0.12,
        "pending": 0.0,
    }
    return mapping.get(as_string(value) or "", 0.35)


def load_tensions(iteration_dir: Path) -> list[TensionSummary]:
    tensions_root = iteration_dir / "tensions"
    tensions: list[TensionSummary] = []
    for tension_dir in list_directories(tensions_root):
        meta = read_json(tension_dir / "meta.json")
        tensions.append(
            TensionSummary(
                id=as_string(meta.get("id")) or tension_dir.name,
                label=as_string(meta.get("label")),
                kind=as_string(meta.get("kind")),
                favored_side=as_string(meta.get("favored_side")),
                why_active=as_string(meta.get("why_active")),
            )
        )
    return tensions


def load_metric_summary(iteration_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    inline_summary = result.get("summary")
    if isinstance(inline_summary, dict) and inline_summary:
        return inline_summary
    execution_summary = read_json(iteration_dir / "execution" / "summary.json")
    if execution_summary:
        return execution_summary
    return {}


def infer_axis_tags(tensions: list[TensionSummary], blob: str) -> list[str]:
    axis_tags = {
        tag
        for tension in tensions
        for tag in (snake_case(tension.kind), snake_case(tension.id))
        if tag and "-vs-" in tag
    }
    fallback_patterns = [
        ("capacity-vs-throughput", r"\bcapacity\b|\bthroughput\b"),
        ("novelty-vs-simplicity", r"\bnovelty\b|\bnovel\b|\bsimplicity\b|\bsimple\b"),
        ("memory-vs-quality", r"\bmemory\b|\bvram\b|\bquality\b"),
        ("optimization-speed-vs-stability", r"\boptimizer\b|\bmuon\b|\badamw\b|\bstability\b"),
        ("short-run-gain-vs-long-run-extensibility", r"\bextensibility\b|\blong-run\b|\bshort-run\b"),
        ("locality-vs-global-context", r"\blocal\b|\bglobal\b|\bcontext\b|\bwindow\b"),
    ]
    for tag, pattern in fallback_patterns:
        if re.search(pattern, blob):
            axis_tags.add(tag)
    return sorted(axis_tags)


def infer_mechanism_tags(blob: str, axis_tags: list[str], move_type: str | None) -> list[str]:
    mechanism_tags = {f"axis:{tag}" for tag in axis_tags}
    if move_type:
        mechanism_tags.add(f"move:{snake_case(move_type)}")
    for pattern, tag in TAG_PATTERNS:
        if re.search(pattern, blob):
            mechanism_tags.add(tag)
    return sorted(mechanism_tags)


def infer_contradiction_class(axis_tags: list[str], contradicted_assumption: str | None, framing_diagnosis: str | None) -> str | None:
    if axis_tags:
        return axis_tags[0]
    blob = inference_blob(contradicted_assumption, framing_diagnosis)
    if "throughput" in blob or "capacity" in blob:
        return "capacity-vs-throughput"
    if "stability" in blob or "optimizer" in blob:
        return "optimization-speed-vs-stability"
    if "memory" in blob or "vram" in blob:
        return "memory-vs-quality"
    if "simple" in blob or "novel" in blob:
        return "novelty-vs-simplicity"
    return None


def infer_confidence(
    *,
    status: str | None,
    keep_discard_status: str | None,
    outcome: str | None,
    framing_diagnosis: str | None,
    value_bpb: float | None,
    blob: str | None,
) -> str:
    status_key = snake_case(status)
    keep_key = snake_case(keep_discard_status)
    outcome_key = snake_case(outcome)
    framing = (framing_diagnosis or "").lower()
    inference = (blob or "").lower()

    if status_key in {"planned", "pending", "running"}:
        return "pending"
    if status_key in {"failed", "crash"}:
        return "failed"
    if "confound" in framing:
        return "confounded"
    if "seed" in framing or "seed" in inference:
        return "seed-sensitive"
    if keep_key == "keep":
        return "strong"
    if outcome_key == "confirmed":
        return "moderate"
    if outcome_key in {"mixed", "contradicted"}:
        return "weak"
    if value_bpb is not None:
        return "moderate"
    return "weak"


def infer_evidence_strength(confidence: str, status: str | None, value_bpb: float | None) -> float:
    status_key = snake_case(status)
    if confidence == "strong":
        return 1.0
    if confidence == "moderate":
        return 0.75
    if confidence == "seed-sensitive":
        return 0.45
    if confidence == "confounded":
        return 0.35
    if confidence == "failed":
        return 0.15
    if confidence == "pending":
        return 0.0
    if status_key == "completed" and value_bpb is not None:
        return 0.6
    return 0.25


def infer_takeaway(
    *,
    status: str | None,
    outcome: str | None,
    summary_text: str | None,
    contradicted_assumption: str | None,
    prediction: str | None,
    value_bpb: float | None,
) -> str:
    if summary_text:
        return compact_text(summary_text, limit=240) or "No takeaway recorded."
    status_key = snake_case(status)
    outcome_key = snake_case(outcome)
    if status_key in {"planned", "pending", "running"}:
        return "Experiment is still in flight, so no distilled takeaway is available yet."
    if status_key in {"failed", "crash"}:
        return "Experiment failed before yielding a stable validation reading."
    if contradicted_assumption:
        prefix = outcome_key.capitalize() if outcome_key else "Observed"
        return compact_text(f"{prefix} result. Contradicted assumption: {contradicted_assumption}", limit=240) or "No takeaway recorded."
    if value_bpb is not None:
        if prediction:
            return compact_text(f"Completed run reached val_bpb {value_bpb:.6f}. Prediction context: {prediction}", limit=240) or "No takeaway recorded."
        return f"Completed run reached val_bpb {value_bpb:.6f}."
    return "No distilled takeaway recorded yet."


def infer_mechanism_hypothesis(prediction: str | None, transcendent: dict[str, Any], summary_text: str | None) -> str | None:
    return compact_text(
        as_string(transcendent.get("emergent_thought"))
        or as_string(transcendent.get("concrete_change"))
        or prediction
        or summary_text,
        limit=240,
    )


def confidence_rank(value: str | None) -> int:
    mapping = {
        "strong": 0,
        "moderate": 1,
        "weak": 2,
        "confounded": 3,
        "seed-sensitive": 4,
        "failed": 5,
        "pending": 6,
    }
    return mapping.get(as_string(value) or "", 7)


def shared_axis_tags(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return sorted(set(left.get("axis_tags") or []) & set(right.get("axis_tags") or []))


def shared_relevance_keys(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return sorted(set(left.get("relevance_keys") or []) & set(right.get("relevance_keys") or []))


def shared_mechanism_tags(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return sorted(set(left.get("mechanism_tags") or []) & set(right.get("mechanism_tags") or []))


def shared_polarity_axes(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    left_polarity = left.get("polarity") or {}
    right_polarity = right.get("polarity") or {}
    return sorted(
        axis
        for axis in set(left_polarity) & set(right_polarity)
        if left_polarity.get(axis) and left_polarity.get(axis) == right_polarity.get(axis)
    )


def corroboration_score(left: dict[str, Any], right: dict[str, Any]) -> float:
    if not (candidate_is_incumbent(left) and candidate_is_incumbent(right)):
        return 0.0

    shared_axes = shared_axis_tags(left, right)
    shared_keys = shared_relevance_keys(left, right)
    shared_mechanisms = shared_mechanism_tags(left, right)
    same_polarity = shared_polarity_axes(left, right)
    if not shared_axes and len(shared_keys) < 2 and len(shared_mechanisms) < 3:
        return 0.0

    score = 0.0
    score += min(0.42, 0.24 + 0.1 * len(shared_axes)) if shared_axes else 0.0
    score += min(0.18, 0.03 * len(shared_keys))
    score += min(0.14, 0.025 * len(shared_mechanisms))
    score += min(0.26, 0.14 + 0.08 * len(same_polarity)) if same_polarity else 0.0

    left_bpb = as_float(left.get("val_bpb"))
    right_bpb = as_float(right.get("val_bpb"))
    if left_bpb is not None and right_bpb is not None:
        delta = abs(left_bpb - right_bpb)
        if delta <= CORROBORATION_SIGNAL_TOLERANCE:
            score += 0.14
        elif delta <= CORROBORATION_SOFT_TOLERANCE:
            score += 0.07

    if snake_case(as_string(left.get("keep_discard_status"))) == "keep" and snake_case(as_string(right.get("keep_discard_status"))) == "keep":
        score += 0.08

    score *= min(confidence_weight(as_string(left.get("confidence"))), confidence_weight(as_string(right.get("confidence"))))
    return round(min(score, 1.0), 6)


def corroborating_experiment_ids(record: dict[str, Any], peers: list[dict[str, Any]]) -> list[str]:
    experiment_id = record["experiment_id"]
    matches: list[str] = []
    for peer in peers:
      if peer["experiment_id"] == experiment_id:
          continue
      if corroboration_score(record, peer) >= 0.45:
          matches.append(peer["experiment_id"])
    return sorted(set(matches))


def corroboration_count(record: dict[str, Any], peers: list[dict[str, Any]]) -> int:
    return len(corroborating_experiment_ids(record, peers))


def candidate_axis_match(record: dict[str, Any], basis_axes: list[str]) -> bool:
    if not basis_axes:
        return False
    return bool(set(record.get("axis_tags") or []) & set(basis_axes))


def incumbent_adjusted_score(record: dict[str, Any], peer_pool: list[dict[str, Any]]) -> float:
    value_bpb = as_float(record.get("val_bpb"))
    if value_bpb is None:
        return float("inf")

    keep_bonus = 0.00018 if snake_case(as_string(record.get("keep_discard_status"))) == "keep" else 0.0
    confidence_penalty = {
        "strong": 0.0,
        "moderate": 0.0002,
        "weak": 0.00075,
        "seed-sensitive": 0.00105,
        "confounded": 0.0015,
    }.get(as_string(record.get("confidence")) or "", 0.0009)

    corroborated_by = corroborating_experiment_ids(record, peer_pool)
    corroboration_bonus = min(0.00054, 0.00018 * len(corroborated_by))
    if not corroborated_by and as_string(record.get("confidence")) in {"seed-sensitive", "confounded"}:
        confidence_penalty += 0.00045

    return round(value_bpb + confidence_penalty - keep_bonus - corroboration_bonus, 6)


def record_sort_key(record: dict[str, Any]) -> tuple[Any, ...]:
    created_at = as_string(record.get("created_at"))
    completed_at = as_string(record.get("completed_at"))
    timestamp = created_at or completed_at
    if timestamp:
        return (0, timestamp, record["session_id"], record["iteration"])
    return (1, record["session_id"], record["iteration"])


def incumbent_sort_key(record: dict[str, Any]) -> tuple[Any, ...]:
    keep_rank = 0 if snake_case(as_string(record.get("keep_discard_status"))) == "keep" else 1
    return (
        record["val_bpb"],
        keep_rank,
        confidence_rank(as_string(record.get("confidence"))),
        as_string(record.get("created_at")) or "",
        record["experiment_id"],
    )


def candidate_is_incumbent(record: dict[str, Any]) -> bool:
    return record.get("status") == "completed" and record.get("val_bpb") is not None


def choose_anchor(prior_records: list[dict[str, Any]], *, basis_axes: list[str] | None = None) -> dict[str, Any] | None:
    candidates = [record for record in prior_records if candidate_is_incumbent(record)]
    if not candidates:
        return None

    global_best = min(
        candidates,
        key=lambda record: (
            incumbent_adjusted_score(record, candidates),
            incumbent_sort_key(record),
        ),
    )

    axis_basis = sorted(set(basis_axes or []))
    axis_candidates = [record for record in candidates if candidate_axis_match(record, axis_basis)]
    if not axis_candidates:
        return global_best

    axis_best = min(
        axis_candidates,
        key=lambda record: (
            incumbent_adjusted_score(record, axis_candidates),
            incumbent_sort_key(record),
        ),
    )

    axis_signal = as_float(axis_best.get("val_bpb"))
    global_signal = as_float(global_best.get("val_bpb"))
    axis_score = incumbent_adjusted_score(axis_best, axis_candidates)
    global_score = incumbent_adjusted_score(global_best, candidates)
    if (
        axis_signal is not None
        and global_signal is not None
        and axis_signal <= global_signal + AXIS_ANCHOR_MAX_SIGNAL_DELTA
        and axis_score <= global_score + AXIS_ANCHOR_MAX_SCORE_DELTA
    ):
        return axis_best

    return global_best


def choose_basis_axes(current_record: dict[str, Any], anchor_record: dict[str, Any]) -> list[str]:
    current_axes = list(current_record.get("axis_tags") or [])
    if current_axes:
        return current_axes
    return list(anchor_record.get("axis_tags") or [])


def choose_basis_keys(current_record: dict[str, Any], anchor_record: dict[str, Any]) -> list[str]:
    current_keys = list(current_record.get("relevance_keys") or [])
    if current_keys:
        return current_keys
    return list(anchor_record.get("relevance_keys") or [])


def score_opposing_candidate(
    *,
    current_record: dict[str, Any],
    anchor_record: dict[str, Any],
    candidate_record: dict[str, Any],
    prior_records: list[dict[str, Any]],
) -> tuple[float, float, float, list[str], list[str]]:
    basis_axes = set(choose_basis_axes(current_record, anchor_record))
    basis_keys = set(choose_basis_keys(current_record, anchor_record))
    candidate_axes = set(candidate_record.get("axis_tags") or [])
    candidate_keys = set(candidate_record.get("relevance_keys") or [])

    shared_axes = sorted(basis_axes & candidate_axes)
    shared_keys = sorted(basis_keys & candidate_keys)
    shared_anchor_axes = sorted(set(anchor_record.get("axis_tags") or []) & candidate_axes)

    anchor_polarity = anchor_record.get("polarity") or {}
    candidate_polarity = candidate_record.get("polarity") or {}
    opposed_axes = sorted(
        axis
        for axis in set(anchor_polarity) & set(candidate_polarity)
        if anchor_polarity.get(axis) and candidate_polarity.get(axis) and anchor_polarity.get(axis) != candidate_polarity.get(axis)
    )

    axis_component = min(0.6, 0.28 * len(shared_axes) + 0.18 * len(shared_anchor_axes))
    key_component = min(0.3, 0.03 * len(shared_keys))
    same_session_bonus = 0.1 if current_record["session_id"] == candidate_record["session_id"] else 0.0
    relevance_score = min(1.0, axis_component + key_component + same_session_bonus)

    polarity_component = min(0.7, 0.45 * len(opposed_axes))
    negate_bonus = 0.15 if snake_case(as_string(candidate_record.get("move_type"))) == "negate" else 0.0
    antithesis_bonus = 0.15 if candidate_record.get("transcendent_role") == "antithesis" else 0.0
    opposition_score = min(1.0, polarity_component + negate_bonus + antithesis_bonus)

    corroboration_bonus = min(0.08, 0.02 * corroboration_count(candidate_record, prior_records))
    total_score = round(
        relevance_score * 0.55
        + opposition_score * 0.35
        + float(candidate_record.get("evidence_strength") or 0.0) * 0.10,
        6,
    )
    total_score = round(total_score + corroboration_bonus, 6)
    return (
        round(relevance_score, 6),
        round(opposition_score, 6),
        total_score,
        shared_axes,
        opposed_axes,
    )


def choose_opposing_record(
    *,
    current_record: dict[str, Any],
    anchor_record: dict[str, Any],
    prior_records: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, str, float, float, float, list[str], list[str]]:
    candidates = [
        record
        for record in prior_records
        if record["experiment_id"] not in {current_record["experiment_id"], anchor_record["experiment_id"]}
        and snake_case(as_string(record.get("status"))) not in {"planned", "pending", "running"}
        and float(record.get("evidence_strength") or 0.0) >= 0.35
    ]

    best_candidate: dict[str, Any] | None = None
    best_reason = "No prior experiment shared enough axis context with the incumbent to form a meaningful opposition."
    best_scores = (0.0, 0.0, 0.0, [], [])

    for candidate in candidates:
        relevance_score, opposition_score, total_score, shared_axes, opposed_axes = score_opposing_candidate(
            current_record=current_record,
            anchor_record=anchor_record,
            candidate_record=candidate,
            prior_records=prior_records,
        )
        has_relevance = bool(shared_axes) or relevance_score >= 0.2
        has_opposition = bool(opposed_axes) or opposition_score >= 0.25
        if not (has_relevance and has_opposition):
            continue
        if best_candidate is None or total_score > best_scores[2]:
            best_candidate = candidate
            best_scores = (relevance_score, opposition_score, total_score, shared_axes, opposed_axes)
            shared_copy = ", ".join(shared_axes) if shared_axes else "shared context"
            opposed_copy = ", ".join(opposed_axes) if opposed_axes else "an inferred opposing posture"
            corroboration = corroboration_count(candidate, prior_records)
            corroboration_copy = (
                f" It is corroborated by {corroboration} related experiment{'s' if corroboration != 1 else ''}."
                if corroboration
                else ""
            )
            best_reason = (
                f"Selected {candidate['experiment_id']} because it overlaps on {shared_copy} "
                f"while pushing against the incumbent on {opposed_copy}.{corroboration_copy}"
            )

    return best_candidate, best_reason, *best_scores


def make_transcendent_prediction(
    *,
    anchor_record: dict[str, Any],
    opposing_record: dict[str, Any] | None,
    shared_axes: list[str],
    opposed_axes: list[str],
) -> str | None:
    if not opposing_record:
        return None
    axis_phrase = ", ".join(opposed_axes or shared_axes) or "the current design axis"
    anchor_takeaway = compact_text(as_string(anchor_record.get("takeaway")), limit=120) or anchor_record["experiment_id"]
    opposing_takeaway = compact_text(as_string(opposing_record.get("takeaway")), limit=120) or opposing_record["experiment_id"]
    return compact_text(
        f"Hold the incumbent strength from {anchor_record['experiment_id']} against the opposing evidence from "
        f"{opposing_record['experiment_id']} on {axis_phrase}, then search for a third train.py variant that "
        f"preserves '{anchor_takeaway}' while integrating '{opposing_takeaway}'.",
        limit=260,
    )


def annotate_corroboration(records: list[dict[str, Any]]) -> None:
    incumbent_candidates = [record for record in records if candidate_is_incumbent(record)]
    for record in records:
        corroborated_by = corroborating_experiment_ids(record, incumbent_candidates)
        record["corroborated_by_experiment_ids"] = corroborated_by
        record["corroborates_experiment_ids"] = corroborated_by
        record["corroboration_count"] = len(corroborated_by)


def build_tension_pairs(records: list[dict[str, Any]]) -> list[TensionPair]:
    ordered_records = sorted(records, key=record_sort_key)
    prior_records: list[dict[str, Any]] = []
    pairs: list[TensionPair] = []
    record_by_id = {record["experiment_id"]: record for record in records}

    for record in ordered_records:
        anchor_record = choose_anchor(prior_records, basis_axes=list(record.get("axis_tags") or []))
        if anchor_record is None:
            pair = TensionPair(
                session_id=record["session_id"],
                iteration=record["iteration"],
                iteration_label=record["iteration_label"],
                experiment_id=record["experiment_id"],
                anchor_experiment_id=None,
                opposing_experiment_id=None,
                selection_reason="No prior completed experiment with numeric val_bpb was available yet.",
                shared_axes=[],
                opposed_axes=[],
                relevance_score=0.0,
                opposition_score=0.0,
                total_score=0.0,
                transcendent_prediction=None,
            )
        else:
            opposing_record, reason, relevance_score, opposition_score, total_score, shared_axes, opposed_axes = choose_opposing_record(
                current_record=record,
                anchor_record=anchor_record,
                prior_records=prior_records,
            )
            pair = TensionPair(
                session_id=record["session_id"],
                iteration=record["iteration"],
                iteration_label=record["iteration_label"],
                experiment_id=record["experiment_id"],
                anchor_experiment_id=anchor_record["experiment_id"],
                opposing_experiment_id=opposing_record["experiment_id"] if opposing_record else None,
                selection_reason=reason,
                shared_axes=shared_axes,
                opposed_axes=opposed_axes,
                relevance_score=relevance_score,
                opposition_score=opposition_score,
                total_score=total_score,
                transcendent_prediction=make_transcendent_prediction(
                    anchor_record=anchor_record,
                    opposing_record=opposing_record,
                    shared_axes=shared_axes,
                    opposed_axes=opposed_axes,
                ),
            )

        record["default_tension_pair"] = {
            "anchor_experiment_id": pair.anchor_experiment_id,
            "opposing_experiment_id": pair.opposing_experiment_id,
            "selection_reason": pair.selection_reason,
            "shared_axes": pair.shared_axes,
            "opposed_axes": pair.opposed_axes,
            "relevance_score": pair.relevance_score,
            "opposition_score": pair.opposition_score,
            "total_score": pair.total_score,
            "transcendent_prediction": pair.transcendent_prediction,
        }
        record["knowledge_anchor_experiment_id"] = pair.anchor_experiment_id
        record["knowledge_opposing_experiment_id"] = pair.opposing_experiment_id
        record["knowledge_selection_reason"] = pair.selection_reason
        record["knowledge_transcendent_prediction"] = pair.transcendent_prediction

        if pair.anchor_experiment_id:
            anchor = record_by_id.get(pair.anchor_experiment_id)
            if anchor is not None:
                anchor.setdefault("supports_experiment_ids", []).append(record["experiment_id"])
        if pair.opposing_experiment_id:
            opposing = record_by_id.get(pair.opposing_experiment_id)
            if opposing is not None:
                opposing.setdefault("opposes_experiment_ids", []).append(record["experiment_id"])

        pairs.append(pair)
        prior_records.append(record)

    for record in records:
        record["supports_experiment_ids"] = sorted(set(record.get("supports_experiment_ids") or []))
        record["opposes_experiment_ids"] = sorted(set(record.get("opposes_experiment_ids") or []))

    return pairs


def build_prepare_suggestion(records: list[dict[str, Any]], *, session_id: str | None = None) -> dict[str, Any]:
    current_record: dict[str, Any] | None = None
    if session_id:
        session_records = [record for record in records if record["session_id"] == session_id]
        if session_records:
            current_record = max(session_records, key=record_sort_key)

    anchor_record = choose_anchor(records, basis_axes=list(current_record.get("axis_tags") or []) if current_record else None)
    if anchor_record is None:
        return {
            "anchor_experiment_id": None,
            "opposing_experiment_id": None,
            "selection_reason": "No prior completed experiment with numeric val_bpb is available yet.",
            "shared_axes": [],
            "opposed_axes": [],
            "relevance_score": 0.0,
            "opposition_score": 0.0,
            "total_score": 0.0,
            "transcendent_prediction": None,
            "anchor_takeaway": None,
            "opposing_takeaway": None,
            "anchor_val_bpb": None,
            "opposing_val_bpb": None,
            "current_context_experiment_id": None,
            "anchor_scope": None,
            "anchor_axis_tags": [],
            "anchor_corroboration_count": 0,
            "opposing_corroboration_count": 0,
        }

    if current_record is None:
        current_record = anchor_record

    opposing_record, reason, relevance_score, opposition_score, total_score, shared_axes, opposed_axes = choose_opposing_record(
        current_record=current_record,
        anchor_record=anchor_record,
        prior_records=records,
    )
    matched_axis_tags = shared_axis_tags(current_record, anchor_record) if current_record else []
    return {
        "anchor_experiment_id": anchor_record["experiment_id"],
        "opposing_experiment_id": opposing_record["experiment_id"] if opposing_record else None,
        "selection_reason": reason,
        "shared_axes": shared_axes,
        "opposed_axes": opposed_axes,
        "relevance_score": relevance_score,
        "opposition_score": opposition_score,
        "total_score": total_score,
        "transcendent_prediction": make_transcendent_prediction(
            anchor_record=anchor_record,
            opposing_record=opposing_record,
            shared_axes=shared_axes,
            opposed_axes=opposed_axes,
        ),
        "anchor_takeaway": anchor_record.get("takeaway"),
        "opposing_takeaway": opposing_record.get("takeaway") if opposing_record else None,
        "anchor_val_bpb": anchor_record.get("val_bpb"),
        "opposing_val_bpb": opposing_record.get("val_bpb") if opposing_record else None,
        "anchor_knowledge_ref": anchor_record.get("knowledge_ref"),
        "opposing_knowledge_ref": opposing_record.get("knowledge_ref") if opposing_record else None,
        "current_context_experiment_id": current_record.get("experiment_id"),
        "anchor_scope": "axis" if matched_axis_tags else "global",
        "anchor_axis_tags": matched_axis_tags,
        "anchor_corroboration_count": anchor_record.get("corroboration_count") or 0,
        "opposing_corroboration_count": opposing_record.get("corroboration_count") or 0 if opposing_record else 0,
    }


def load_iteration_record(repo_root: Path, session_dir: Path, session_data: dict[str, Any], iteration_dir: Path) -> dict[str, Any]:
    plan = read_json(iteration_dir / "plan.json")
    result = read_json(iteration_dir / "result.json")
    transcendent = read_json(iteration_dir / "transcendent" / "result.json")
    summary = load_metric_summary(iteration_dir, result)
    tensions = load_tensions(iteration_dir)

    session_id = as_string(session_data.get("session_id")) or session_dir.name
    branch = as_string(session_data.get("branch")) or session_dir.name
    iteration_label = iteration_dir.name
    iteration_number = int(as_string(plan.get("iteration")) or as_string(result.get("iteration")) or iteration_label)
    status = as_string(result.get("status")) or as_string(plan.get("status"))
    outcome = as_string(result.get("outcome"))
    keep_discard_status = as_string(result.get("keep_discard_status"))
    prediction = as_string(plan.get("prediction"))
    summary_text = as_string(result.get("summary_text"))
    contradicted_assumption = as_string(result.get("contradicted_assumption"))
    framing_diagnosis = as_string(result.get("framing_diagnosis"))
    move_type = as_string(plan.get("move_type"))
    value_bpb = as_float(summary.get("val_bpb"))

    blob = inference_blob(
        prediction,
        summary_text,
        contradicted_assumption,
        framing_diagnosis,
        as_string(plan.get("thesis")),
        as_string(plan.get("antithesis")),
        as_string(plan.get("synthesis_candidate")),
        as_string(transcendent.get("emergent_thought")),
        as_string(transcendent.get("concrete_change")),
        "\n".join(filter(None, (tension.label for tension in tensions))),
        "\n".join(filter(None, (tension.kind for tension in tensions))),
        "\n".join(filter(None, (tension.why_active for tension in tensions))),
    )
    axis_tags = infer_axis_tags(tensions, blob)
    mechanism_tags = infer_mechanism_tags(blob, axis_tags, move_type)
    contradiction_class = infer_contradiction_class(axis_tags, contradicted_assumption, framing_diagnosis)
    confidence = infer_confidence(
        status=status,
        keep_discard_status=keep_discard_status,
        outcome=outcome,
        framing_diagnosis=framing_diagnosis,
        value_bpb=value_bpb,
        blob=blob,
    )
    evidence_strength = infer_evidence_strength(confidence, status, value_bpb)
    takeaway = infer_takeaway(
        status=status,
        outcome=outcome,
        summary_text=summary_text,
        contradicted_assumption=contradicted_assumption,
        prediction=prediction,
        value_bpb=value_bpb,
    )
    mechanism_hypothesis = infer_mechanism_hypothesis(prediction, transcendent, summary_text)
    polarity = {
        tag: tension.favored_side
        for tension in tensions
        for tag in (snake_case(tension.kind), snake_case(tension.id))
        if tag and "-vs-" in tag and tension.favored_side
    }
    relevance_keys = sorted(set(axis_tags + mechanism_tags))

    return {
        "schema_version": SCHEMA_VERSION,
        "experiment_id": f"{session_id}:{iteration_label}",
        "session_id": session_id,
        "iteration": iteration_number,
        "iteration_label": iteration_label,
        "branch": branch,
        "runner_mode": as_string(session_data.get("runner_mode")),
        "source_iteration_path": relative_to_repo(repo_root, iteration_dir),
        "created_at": as_string(plan.get("created_at")) or as_string(result.get("created_at")),
        "completed_at": as_string(result.get("completed_at")),
        "status": status,
        "parent_commit": as_string(plan.get("parent_commit")),
        "candidate_commit": as_string(plan.get("candidate_commit")),
        "move_type": move_type,
        "prediction": prediction,
        "summary_text": summary_text,
        "outcome": outcome,
        "keep_discard_status": keep_discard_status,
        "contradicted_assumption": contradicted_assumption,
        "framing_diagnosis": framing_diagnosis,
        "val_bpb": value_bpb,
        "metrics": summary,
        "delta_vs_parent": None,
        "delta_vs_incumbent": None,
        "takeaway": takeaway,
        "mechanism_hypothesis": mechanism_hypothesis,
        "contradiction_class": contradiction_class,
        "mechanism_tags": mechanism_tags,
        "axis_tags": axis_tags,
        "polarity": polarity,
        "confidence": confidence,
        "evidence_strength": evidence_strength,
        "is_incumbent_candidate": status == "completed" and value_bpb is not None,
        "incumbent_rank": None,
        "corroborated_by_experiment_ids": [],
        "corroborates_experiment_ids": [],
        "corroboration_count": 0,
        "relevance_keys": relevance_keys,
        "opposes_experiment_ids": [],
        "supports_experiment_ids": [],
        "transcendent_role": "synthesis" if move_type == "synthesize" else ("antithesis" if move_type == "negate" else "thesis"),
        "active_tension_ids": list(plan.get("active_tension_ids") or []),
        "tension_count": len(tensions),
        "tensions": [
            {
                "id": tension.id,
                "label": tension.label,
                "kind": tension.kind,
                "favored_side": tension.favored_side,
                "why_active": compact_text(tension.why_active, limit=180),
            }
            for tension in tensions
        ],
        "transcendent": {
            "source_tension_ids": list(transcendent.get("source_tension_ids") or []),
            "thesis_ref": as_string(transcendent.get("thesis_ref")),
            "antithesis_ref": as_string(transcendent.get("antithesis_ref")),
            "emergent_thought": compact_text(as_string(transcendent.get("emergent_thought")), limit=220),
            "concrete_change": compact_text(as_string(transcendent.get("concrete_change")), limit=220),
            "tested_in_iteration": transcendent.get("tested_in_iteration"),
            "result_status": as_string(transcendent.get("result_status")),
        },
        "knowledge_ref": f"knowledge_base/experiments/{session_id}/{iteration_label}.json",
    }


def build_records(repo_root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[TensionPair]]:
    experiment_logs_root = repo_root / EXPERIMENT_LOGS_DIRNAME
    session_summaries: list[dict[str, Any]] = []
    contexts: list[IterationContext] = []

    for session_dir in list_directories(experiment_logs_root):
        session_data = read_json(session_dir / "session.json")
        manifest = read_json(session_dir / "manifest.json")
        branch = as_string(session_data.get("branch")) or as_string(manifest.get("branch")) or session_dir.name
        session_id = as_string(session_data.get("session_id")) or session_dir.name

        session_contexts: list[IterationContext] = []
        last_numeric_value: float | None = None

        for iteration_dir in list_directories(session_dir / "iterations"):
            record = load_iteration_record(repo_root, session_dir, session_data or manifest, iteration_dir)
            if record["val_bpb"] is not None and last_numeric_value is not None:
                record["delta_vs_parent"] = round(record["val_bpb"] - last_numeric_value, 6)
            session_contexts.append(IterationContext(record=record, value_bpb=record["val_bpb"]))
            if record["val_bpb"] is not None:
                last_numeric_value = record["val_bpb"]

        completed_numeric = [context for context in session_contexts if context.value_bpb is not None and context.record.get("status") == "completed"]
        best_record = choose_anchor([context.record for context in completed_numeric])
        session_summary = {
            "schema_version": SCHEMA_VERSION,
            "session_id": session_id,
            "branch": branch,
            "source_session_path": relative_to_repo(repo_root, session_dir),
            "created_at": as_string(session_data.get("created_at")) or as_string(manifest.get("created_at")),
            "updated_at": as_string(session_data.get("updated_at")) or as_string(manifest.get("updated_at")),
            "iteration_count": len(session_contexts),
            "completed_count": sum(1 for context in session_contexts if context.record.get("status") == "completed"),
            "failed_count": sum(1 for context in session_contexts if context.record.get("status") == "failed"),
            "pending_count": sum(1 for context in session_contexts if context.record.get("status") in {"planned", "pending", "running"}),
            "best_experiment_id": best_record["experiment_id"] if best_record else None,
            "best_val_bpb": best_record.get("val_bpb") if best_record else None,
            "experiment_ids": [context.record["experiment_id"] for context in session_contexts],
        }
        session_summaries.append(session_summary)
        contexts.extend(session_contexts)

    records = [context.record for context in contexts]
    annotate_corroboration(records)

    records_by_session: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        records_by_session.setdefault(record["session_id"], []).append(record)
    for summary in session_summaries:
        session_anchor = choose_anchor(records_by_session.get(summary["session_id"], []))
        summary["best_experiment_id"] = session_anchor["experiment_id"] if session_anchor else None
        summary["best_val_bpb"] = session_anchor.get("val_bpb") if session_anchor else None

    numeric_contexts = [context for context in contexts if context.value_bpb is not None and context.record.get("status") == "completed"]
    numeric_contexts.sort(
        key=lambda context: (
            incumbent_adjusted_score(context.record, [candidate.record for candidate in numeric_contexts]),
            incumbent_sort_key(context.record),
        )
    )

    global_anchor = choose_anchor(records)
    global_incumbent_value = as_float(global_anchor.get("val_bpb")) if global_anchor else None
    for rank, context in enumerate(numeric_contexts, start=1):
        context.record["incumbent_rank"] = rank
        if global_incumbent_value is not None:
            context.record["delta_vs_incumbent"] = round(context.value_bpb - global_incumbent_value, 6)
    tension_pairs = build_tension_pairs(records)

    pairs_by_session: dict[str, list[TensionPair]] = {}
    for pair in tension_pairs:
        pairs_by_session.setdefault(pair.session_id, []).append(pair)

    for summary in session_summaries:
        session_pairs = pairs_by_session.get(summary["session_id"], [])
        summary["default_tension_pair_count"] = len(session_pairs)
        summary["default_tension_pairs_with_opposition"] = sum(1 for pair in session_pairs if pair.opposing_experiment_id)
        latest_pair = session_pairs[-1] if session_pairs else None
        summary["latest_anchor_experiment_id"] = latest_pair.anchor_experiment_id if latest_pair else None
        summary["latest_opposing_experiment_id"] = latest_pair.opposing_experiment_id if latest_pair else None

    records.sort(key=lambda record: (record["session_id"], record["iteration"]))
    session_summaries.sort(key=lambda summary: summary["session_id"])
    return records, session_summaries, tension_pairs


def build_incumbents(records: list[dict[str, Any]]) -> dict[str, Any]:
    completed_numeric = [
        record
        for record in records
        if record.get("status") == "completed" and record.get("val_bpb") is not None
    ]
    completed_numeric.sort(
        key=lambda record: (
            incumbent_adjusted_score(record, completed_numeric),
            incumbent_sort_key(record),
        )
    )

    kept_numeric = [
        record
        for record in completed_numeric
        if snake_case(as_string(record.get("keep_discard_status"))) == "keep"
    ]

    best_per_session: dict[str, dict[str, Any]] = {}
    best_per_axis: dict[str, dict[str, Any]] = {}
    for session_id in sorted({record["session_id"] for record in completed_numeric}):
        session_records = [record for record in completed_numeric if record["session_id"] == session_id]
        session_anchor = choose_anchor(session_records)
        if session_anchor is not None:
            best_per_session[session_id] = {
                "experiment_id": session_anchor["experiment_id"],
                "val_bpb": session_anchor["val_bpb"],
                "knowledge_ref": session_anchor["knowledge_ref"],
                "confidence": session_anchor["confidence"],
                "corroboration_count": session_anchor.get("corroboration_count") or 0,
            }

    axis_tags = sorted({axis for record in completed_numeric for axis in record.get("axis_tags", [])})
    for axis_tag in axis_tags:
        axis_records = [record for record in completed_numeric if axis_tag in record.get("axis_tags", [])]
        axis_anchor = choose_anchor(axis_records, basis_axes=[axis_tag])
        if axis_anchor is not None:
            best_per_axis[axis_tag] = {
                "experiment_id": axis_anchor["experiment_id"],
                "val_bpb": axis_anchor["val_bpb"],
                "knowledge_ref": axis_anchor["knowledge_ref"],
                "confidence": axis_anchor["confidence"],
                "corroboration_count": axis_anchor.get("corroboration_count") or 0,
            }

    def incumbent_payload(record: dict[str, Any] | None) -> dict[str, Any] | None:
        if not record:
            return None
        return {
            "experiment_id": record["experiment_id"],
            "session_id": record["session_id"],
            "iteration": record["iteration"],
            "val_bpb": record["val_bpb"],
            "knowledge_ref": record["knowledge_ref"],
            "takeaway": record["takeaway"],
            "confidence": record["confidence"],
            "corroboration_count": record.get("corroboration_count") or 0,
            "adjusted_incumbent_score": incumbent_adjusted_score(record, completed_numeric),
        }

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso_now(),
        "global_best": incumbent_payload(completed_numeric[0]) if completed_numeric else None,
        "best_kept": incumbent_payload(kept_numeric[0]) if kept_numeric else None,
        "best_per_session": best_per_session,
        "best_per_axis": best_per_axis,
    }


def schema_payload() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso_now(),
        "description": "Distilled experiment knowledge derived from canonical experiment_logs.",
        "files": {
            "experiments.jsonl": "Flat index of all distilled experiment records.",
            "incumbents.json": "Current best-known experiments across global, session, and axis views.",
            "tensions.jsonl": "Generated default tension pairs with anchor/opposition scoring.",
            "sessions/<session-id>.json": "Session-level knowledge summaries.",
            "experiments/<session-id>/<iteration>.json": "Per-iteration distilled experiment knowledge record.",
        },
    }


def rebuild_knowledge_base(
    repo_root: Path,
    knowledge_root: Path,
    *,
    suggestion_session_id: str | None = None,
) -> dict[str, Any]:
    records, session_summaries, tension_pairs = build_records(repo_root)
    incumbents = build_incumbents(records)
    prepare_suggestion = build_prepare_suggestion(records, session_id=suggestion_session_id)

    write_json(knowledge_root / "schema.json", schema_payload())
    write_jsonl(knowledge_root / "experiments.jsonl", records)
    write_json(knowledge_root / "incumbents.json", incumbents)
    write_jsonl(
        knowledge_root / "tensions.jsonl",
        [
            {
                "schema_version": SCHEMA_VERSION,
                "session_id": pair.session_id,
                "iteration": pair.iteration,
                "iteration_label": pair.iteration_label,
                "experiment_id": pair.experiment_id,
                "anchor_experiment_id": pair.anchor_experiment_id,
                "opposing_experiment_id": pair.opposing_experiment_id,
                "selection_reason": pair.selection_reason,
                "shared_axes": pair.shared_axes,
                "opposed_axes": pair.opposed_axes,
                "relevance_score": pair.relevance_score,
                "opposition_score": pair.opposition_score,
                "total_score": pair.total_score,
                "transcendent_prediction": pair.transcendent_prediction,
            }
            for pair in tension_pairs
        ],
    )

    for summary in session_summaries:
        write_json(knowledge_root / "sessions" / f"{summary['session_id']}.json", summary)

    for record in records:
        write_json(
            knowledge_root / "experiments" / record["session_id"] / f"{record['iteration_label']}.json",
            record,
        )

    return {
        "record_count": len(records),
        "session_count": len(session_summaries),
        "tension_pair_count": len(tension_pairs),
        "tension_pair_with_opposition_count": sum(1 for pair in tension_pairs if pair.opposing_experiment_id),
        "global_best": incumbents.get("global_best"),
        "best_kept": incumbents.get("best_kept"),
        "prepare_suggestion": prepare_suggestion,
    }


def seed_state_with_knowledge_suggestion(state_path: Path, suggestion: dict[str, Any] | None) -> None:
    if suggestion is None:
        return
    if state_path.exists():
        state = read_json(state_path)
    else:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state = {
            "active_tensions": [],
            "result": {},
            "transcendent": {},
        }
    state["knowledge_anchor_experiment_id"] = suggestion.get("anchor_experiment_id")
    state["knowledge_opposing_experiment_id"] = suggestion.get("opposing_experiment_id")
    state["knowledge_selection_reason"] = suggestion.get("selection_reason")
    state["knowledge_transcendent_prediction"] = suggestion.get("transcendent_prediction")
    write_json(state_path, state)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root containing experiment_logs/.",
    )
    parser.add_argument(
        "--knowledge-dir",
        type=Path,
        default=None,
        help="Output directory for knowledge_base/. Defaults to <repo-root>/knowledge_base.",
    )
    parser.add_argument(
        "--print-summary",
        action="store_true",
        help="Print a small JSON summary after rebuilding.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    knowledge_root = args.knowledge_dir.resolve() if args.knowledge_dir else repo_root / DEFAULT_KNOWLEDGE_DIRNAME
    summary = rebuild_knowledge_base(repo_root, knowledge_root)
    if args.print_summary:
        print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
