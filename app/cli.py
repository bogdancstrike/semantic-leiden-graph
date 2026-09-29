"""Command-line access to the same use cases as the HTTP API.

    python -m app.cli ingest "some text" [--id ext-1]
    python -m app.cli ingest-csv data/sample.csv [--no-cluster]
    python -m app.cli rebuild-graph [--k 12 --min-similarity 0.6]
    python -m app.cli cluster [--gamma 1.2]
    python -m app.cli communities
    python -m app.cli search "query" [--mode hybrid --scope auto --top-k 10]
    python -m app.cli reconcile
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from app.config import get_settings
from app.main import build_container
from app.schemas import DocumentIn, Scope, ScopeType, SearchMode, SearchRequest


class _CliContext:
    """Minimal JobContext stand-in that prints progress."""

    def progress(self, phase: str, processed: int, total: int | None = None, message: str | None = None) -> None:
        suffix = f"/{total}" if total else ""
        print(f"\r{phase:<22} {processed}{suffix}", end="", file=sys.stderr, flush=True)

    def check_cancelled(self) -> None:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Semantic Leiden PoC CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    ingest = sub.add_parser("ingest")
    ingest.add_argument("text")
    ingest.add_argument("--id")

    csv_cmd = sub.add_parser("ingest-csv")
    csv_cmd.add_argument("path", type=Path)
    csv_cmd.add_argument("--no-cluster", action="store_true")
    csv_cmd.add_argument("--rebuild", action="store_true")
    csv_cmd.add_argument("--text-column", help="the column to analyse (default: a column named 'text')")
    csv_cmd.add_argument("--id-column", help="default: a column named 'id', else ids from the text")
    csv_cmd.add_argument("--delimiter", help="one character or comma/semicolon/tab/pipe (default: detected)")
    csv_cmd.add_argument("--encoding", help="e.g. utf-8, windows-1252 (default: detected)")
    csv_cmd.add_argument("--no-header", action="store_true", help="the first row is data; columns are column_1 ...")
    csv_cmd.add_argument("--min-community-size", type=int, help="clustering afterwards: smallest community (>= 2)")

    rebuild = sub.add_parser("rebuild-graph")
    rebuild.add_argument("--k", type=int)
    rebuild.add_argument("--min-similarity", type=float)

    cluster = sub.add_parser("cluster")
    cluster.add_argument("--gamma", type=float)
    cluster.add_argument("--seed", type=int)

    sub.add_parser("communities")
    sub.add_parser("stats")
    sub.add_parser("reconcile")

    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--mode", choices=[m.value for m in SearchMode], default="semantic")
    search.add_argument("--scope", choices=[s.value for s in ScopeType], default="global")
    search.add_argument("--community", type=int, action="append", default=[])
    search.add_argument("--top-k", type=int, default=10)

    args = parser.parse_args()
    settings = get_settings()
    container = build_container(settings)
    container.initialize()
    ctx = _CliContext()
    started = time.perf_counter()
    try:
        if args.command == "ingest":
            result = container.ingest_documents([DocumentIn(id=args.id, text=args.text)], source="cli")
        elif args.command == "ingest-csv":
            from app.pipeline.csv_reader import detect_layout

            layout = detect_layout(
                args.path,
                settings.metadata_max_keys,
                text_column=args.text_column,
                id_column=args.id_column,
                delimiter=args.delimiter,
                encoding=args.encoding,
                has_header=not args.no_header,
            )
            result = container._import_csv(  # noqa: SLF001 - CLI runs the job body synchronously
                ctx,
                args.path,
                layout,
                f"csv:{args.path.name}",
                not args.no_cluster,
                args.rebuild,
                min_community_size=args.min_community_size,
            )
        elif args.command == "rebuild-graph":
            result = container._rebuild(ctx, args.k, args.min_similarity)  # noqa: SLF001
        elif args.command == "cluster":
            result = container._cluster(ctx, args.gamma, args.seed)  # noqa: SLF001
        elif args.command == "communities":
            result = {"communities": container.communities()}
        elif args.command == "stats":
            result = container.stats()
        elif args.command == "reconcile":
            result = container._reconcile(ctx)  # noqa: SLF001
        else:
            scope = Scope(type=ScopeType(args.scope), community_ids=args.community)
            response, _ = container.search_engine.search(
                SearchRequest(query=args.query, mode=SearchMode(args.mode), scope=scope, top_k=args.top_k)
            )
            result = response.model_dump(exclude_none=True)
        print(file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        print(f"done in {(time.perf_counter() - started):.2f}s", file=sys.stderr)
    finally:
        container.close()


if __name__ == "__main__":
    main()
