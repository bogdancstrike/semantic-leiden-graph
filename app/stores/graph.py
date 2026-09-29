"""Neo4j + GDS: authority for semantic topology and community assignment.

All writes are batched with ``UNWIND`` inside managed transactions
(``execute_write``), which the driver retries automatically on transient errors
(leader switches, deadlocks). v0.2 opened one session per edge.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from neo4j import GraphDatabase, RoutingControl

from app.config import Settings
from app.errors import DependencyUnavailable

log = logging.getLogger(__name__)


def canonical_edges(edges: list[tuple[str, str, float]]) -> list[dict]:
    """Deduplicate undirected pairs; keep the max score seen for a pair."""
    best: dict[tuple[str, str], float] = {}
    for a, b, score in edges:
        if a == b:
            continue
        key = (a, b) if a < b else (b, a)
        if score > best.get(key, float("-inf")):
            best[key] = score
    return [{"a": a, "b": b, "score": float(s)} for (a, b), s in best.items()]


class GraphStore:
    GRAPH_NAME = "semanticGraph"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.database = settings.neo4j_database
        self.driver = GraphDatabase.driver(
            settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password.get_secret_value()),
            max_connection_pool_size=50,
            connection_acquisition_timeout=30,
        )

    def close(self) -> None:
        self.driver.close()

    # ------------------------------------------------------------------ helpers

    def _read(self, query: str, **params: Any) -> list[dict]:
        records, _, _ = self.driver.execute_query(
            query, params, database_=self.database, routing_=RoutingControl.READ
        )
        return [record.data() for record in records]

    def _write(self, query: str, **params: Any) -> list[dict]:
        records, _, _ = self.driver.execute_query(query, params, database_=self.database)
        return [record.data() for record in records]

    def _write_batched(self, query: str, rows: list[dict] | list[str], key: str = "rows") -> None:
        size = self.settings.graph_write_batch
        with self.driver.session(database=self.database) as session:
            for start in range(0, len(rows), size):
                chunk = rows[start : start + size]
                session.execute_write(lambda tx, c=chunk: tx.run(query, {key: c}).consume())

    # ------------------------------------------------------------------ lifecycle

    def ping(self) -> bool:
        try:
            self.driver.verify_connectivity()
            return True
        except Exception:  # noqa: BLE001
            return False

    def ensure_schema(self) -> None:
        try:
            self.driver.verify_connectivity()
        except Exception as exc:  # noqa: BLE001
            raise DependencyUnavailable(f"Neo4j is not reachable: {exc}") from exc
        self._write("CREATE CONSTRAINT document_id_unique IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE")
        self._write("CREATE INDEX document_community IF NOT EXISTS FOR (d:Document) ON (d.communityId)")
        self._write("CREATE CONSTRAINT cluster_run_version IF NOT EXISTS FOR (r:ClusterRun) REQUIRE r.version IS UNIQUE")
        self._write("CREATE CONSTRAINT graph_policy_key IF NOT EXISTS FOR (p:GraphPolicy) REQUIRE p.key IS UNIQUE")

    def gds_version(self) -> str | None:
        try:
            return self._read("RETURN gds.version() AS v")[0]["v"]
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------------ nodes & edges

    def upsert_nodes(self, ids: list[str]) -> None:
        self._write_batched("UNWIND $rows AS id MERGE (:Document {id: id})", ids)

    def reset_documents(self, ids: list[str]) -> None:
        """Content changed: drop incident edges and stale community assignment."""
        self._write_batched(
            """
            UNWIND $rows AS id
            MATCH (d:Document {id: id})
            SET d.communityId = null
            WITH d
            OPTIONAL MATCH (d)-[r:SIMILAR_TO]-()
            DELETE r
            """,
            ids,
        )

    def upsert_edges(self, edges: list[dict]) -> int:
        self._write_batched(
            """
            UNWIND $rows AS e
            MATCH (a:Document {id: e.a})
            MATCH (b:Document {id: e.b})
            MERGE (a)-[r:SIMILAR_TO]->(b)
            SET r.score = e.score
            """,
            edges,
        )
        return len(edges)

    def delete_all_edges(self) -> int:
        deleted = 0
        while True:
            rows = self._write(
                "MATCH ()-[r:SIMILAR_TO]->() WITH r LIMIT 20000 DELETE r RETURN count(*) AS n"
            )
            n = int(rows[0]["n"]) if rows else 0
            deleted += n
            if n == 0:
                return deleted

    def iter_ids(self) -> list[str]:
        return [row["id"] for row in self._read("MATCH (d:Document) RETURN d.id AS id")]

    def delete_nodes(self, ids: list[str]) -> None:
        self._write_batched("UNWIND $rows AS id MATCH (d:Document {id: id}) DETACH DELETE d", ids)

    def delete_nodes_counted(self, ids: list[str]) -> int:
        """``delete_nodes`` that reports how many nodes existed."""
        deleted = 0
        size = self.settings.graph_write_batch
        for start in range(0, len(ids), size):
            rows = self._write(
                "UNWIND $rows AS id MATCH (d:Document {id: id}) DETACH DELETE d RETURN count(*) AS n",
                rows=ids[start : start + size],
            )
            deleted += int(rows[0]["n"]) if rows else 0
        return deleted

    # ------------------------------------------------------------------ policy & runs

    def load_policy(self) -> dict | None:
        rows = self._read(
            "MATCH (p:GraphPolicy {key: 'active'}) RETURN p.neighbor_k AS neighbor_k, "
            "p.min_similarity AS min_similarity, p.updated_at AS updated_at"
        )
        if not rows:
            return None
        row = rows[0]
        updated = row["updated_at"]
        return {
            "neighbor_k": int(row["neighbor_k"]),
            "min_similarity": float(row["min_similarity"]),
            "updated_at": updated.to_native() if hasattr(updated, "to_native") else updated,
        }

    def save_policy(self, neighbor_k: int, min_similarity: float) -> None:
        self._write(
            """
            MERGE (p:GraphPolicy {key: 'active'})
            SET p.neighbor_k = $k, p.min_similarity = $s, p.updated_at = datetime()
            """,
            k=int(neighbor_k),
            s=float(min_similarity),
        )

    def next_cluster_version(self) -> int:
        rows = self._read("MATCH (r:ClusterRun) RETURN coalesce(max(r.version), 0) AS v")
        return int(rows[0]["v"]) + 1 if rows else 1

    def save_cluster_run(self, run: dict) -> None:
        self._write("CREATE (r:ClusterRun) SET r = $run, r.ran_at = datetime()", run=run)

    def cluster_runs(self, limit: int = 20) -> list[dict]:
        rows = self._read(
            "MATCH (r:ClusterRun) RETURN r ORDER BY r.version DESC LIMIT $limit", limit=int(limit)
        )
        runs = []
        for row in rows:
            run = dict(row["r"])
            if hasattr(run.get("ran_at"), "to_native"):
                run["ran_at"] = run["ran_at"].to_native().isoformat()
            runs.append(run)
        return runs

    # ------------------------------------------------------------------ Leiden

    def run_leiden(self, gamma: float, seed: int) -> dict:
        """Project -> Leiden (write) -> drop projection.

        The projection is dropped afterwards (v0.2 kept it resident): GDS projections
        live on the Neo4j heap and there is no reason to hold that memory between runs.
        """
        started = time.perf_counter()
        self._drop_projection()
        try:
            projection = self._write(
                """
                CALL gds.graph.project(
                  $name, 'Document',
                  {SIMILAR_TO: {type: 'SIMILAR_TO', orientation: 'UNDIRECTED', properties: 'score'}}
                )
                YIELD nodeCount, relationshipCount, projectMillis
                RETURN nodeCount, relationshipCount, projectMillis
                """,
                name=self.GRAPH_NAME,
            )[0]
            row = self._write(
                """
                CALL gds.leiden.write($name, {
                  writeProperty: 'communityId',
                  relationshipWeightProperty: 'score',
                  gamma: $gamma,
                  randomSeed: $seed
                })
                YIELD communityCount, nodePropertiesWritten, modularity, ranLevels, computeMillis, writeMillis
                RETURN communityCount, nodePropertiesWritten, modularity, ranLevels, computeMillis, writeMillis
                """,
                name=self.GRAPH_NAME,
                gamma=float(gamma),
                seed=int(seed),
            )[0]
        finally:
            self._drop_projection()
        return {
            "community_count": int(row["communityCount"]),
            "node_properties_written": int(row["nodePropertiesWritten"]),
            "modularity": float(row["modularity"]),
            "ran_levels": int(row["ranLevels"]),
            "node_count": int(projection["nodeCount"]),
            "relationship_count": int(projection["relationshipCount"]),
            "project_ms": int(projection["projectMillis"]),
            "compute_ms": int(row["computeMillis"]),
            "write_ms": int(row["writeMillis"]),
            "leiden_total_ms": int((time.perf_counter() - started) * 1000),
        }

    def _drop_projection(self) -> None:
        self._write(
            "CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName", name=self.GRAPH_NAME
        )

    def set_community_ids(self, assignments: list[tuple[str, int | None]]) -> None:
        """Overwrite Leiden's raw ids with the final ones; ``None`` removes the property."""
        self._write_batched(
            "UNWIND $rows AS row MATCH (d:Document {id: row.id}) SET d.communityId = row.c",
            [{"id": doc_id, "c": community} for doc_id, community in assignments],
        )

    def assignments(self) -> list[tuple[str, int]]:
        rows = self._read(
            "MATCH (d:Document) WHERE d.communityId IS NOT NULL RETURN d.id AS id, d.communityId AS c"
        )
        return [(row["id"], int(row["c"])) for row in rows]

    # ------------------------------------------------------------------ analytics

    def stats(self) -> dict:
        row = self._read(
            """
            CALL () { MATCH (d:Document) RETURN count(d) AS nodes }
            CALL () { MATCH ()-[r:SIMILAR_TO]->() RETURN count(r) AS edges }
            CALL () { MATCH (d:Document) WHERE d.communityId IS NOT NULL RETURN count(DISTINCT d.communityId) AS communities }
            CALL () { MATCH (d:Document) WHERE NOT (d)-[:SIMILAR_TO]-() RETURN count(d) AS isolated }
            RETURN nodes, edges, communities, isolated
            """
        )[0]
        nodes = int(row["nodes"])
        edges = int(row["edges"])
        return {
            "nodes": nodes,
            "edges": edges,
            "communities": int(row["communities"]),
            "isolated_nodes": int(row["isolated"]),
            "mean_degree": round(2 * edges / nodes, 3) if nodes else 0.0,
        }

    def list_communities(self) -> list[dict]:
        """Size plus graph-only quality metrics (no text enrichment involved).

        * ``avg_similarity``: mean score of edges fully inside the community
        * ``density``: internal edges / possible pairs
        * ``conductance``: boundary weight / (2*internal weight + boundary weight);
          0 = perfectly separated, 1 = no internal cohesion
        """
        rows = self._read(
            """
            MATCH (d:Document) WHERE d.communityId IS NOT NULL
            WITH d.communityId AS cid, collect(d) AS members
            UNWIND members AS m
            OPTIONAL MATCH (m)-[r:SIMILAR_TO]-(o:Document)
            WITH cid, size(members) AS memberCount,
                 sum(CASE WHEN o.communityId = cid THEN r.score ELSE 0.0 END) / 2.0 AS internalW,
                 sum(CASE WHEN o.communityId = cid THEN 1 ELSE 0 END) / 2 AS internalE,
                 sum(CASE WHEN r IS NOT NULL AND (o.communityId IS NULL OR o.communityId <> cid) THEN r.score ELSE 0.0 END) AS boundaryW,
                 sum(CASE WHEN r IS NOT NULL AND (o.communityId IS NULL OR o.communityId <> cid) THEN 1 ELSE 0 END) AS boundaryE
            RETURN cid, memberCount, internalW, internalE, boundaryW, boundaryE
            ORDER BY memberCount DESC, cid
            """
        )
        out = []
        for row in rows:
            size = int(row["memberCount"])
            internal_e = int(row["internalE"])
            internal_w = float(row["internalW"])
            boundary_w = float(row["boundaryW"])
            possible = size * (size - 1) / 2
            denominator = 2 * internal_w + boundary_w
            out.append(
                {
                    "community_id": int(row["cid"]),
                    "size": size,
                    "internal_edges": internal_e,
                    "boundary_edges": int(row["boundaryE"]),
                    "avg_similarity": round(internal_w / internal_e, 4) if internal_e else 0.0,
                    "density": round(internal_e / possible, 4) if possible else 0.0,
                    "conductance": round(boundary_w / denominator, 4) if denominator else 0.0,
                }
            )
        return out

    def community_detail(self, community_id: int, limit: int = 10) -> dict:
        central = self._read(
            """
            MATCH (d:Document {communityId: $cid})
            OPTIONAL MATCH (d)-[r:SIMILAR_TO]-(o:Document {communityId: $cid})
            WITH d, sum(coalesce(r.score, 0.0)) AS strength, count(r) AS degree
            RETURN d.id AS id, strength, degree
            ORDER BY strength DESC, id LIMIT $limit
            """,
            cid=int(community_id),
            limit=int(limit),
        )
        bridges = self._read(
            """
            MATCH (d:Document {communityId: $cid})-[r:SIMILAR_TO]-(o:Document)
            WHERE o.communityId IS NOT NULL AND o.communityId <> $cid
            RETURN o.communityId AS community_id, count(r) AS edges, avg(r.score) AS avg_score
            ORDER BY edges DESC, avg_score DESC LIMIT 10
            """,
            cid=int(community_id),
        )
        return {
            "central": [
                {"id": r["id"], "strength": round(float(r["strength"]), 4), "degree": int(r["degree"])} for r in central
            ],
            "neighbouring_communities": [
                {"community_id": int(r["community_id"]), "edges": int(r["edges"]), "avg_score": round(float(r["avg_score"]), 4)}
                for r in bridges
            ],
        }

    def neighbors(self, doc_id: str, limit: int) -> list[dict]:
        rows = self._read(
            """
            MATCH (d:Document {id: $id})-[r:SIMILAR_TO]-(o:Document)
            RETURN o.id AS id, o.communityId AS community_id, r.score AS score
            ORDER BY score DESC LIMIT $limit
            """,
            id=doc_id,
            limit=int(limit),
        )
        return [
            {"id": r["id"], "community_id": r["community_id"], "score": float(r["score"])} for r in rows
        ]

    def graph_data(self, limit: int, community_ids: list[int] | None, min_score: float, max_score: float = 1.0) -> dict:
        """The strongest edges inside the similarity band [min_score, max_score]."""
        rows = self._read(
            """
            MATCH (a:Document)-[r:SIMILAR_TO]->(b:Document)
            WHERE r.score >= $minScore AND r.score <= $maxScore
              AND ($cids IS NULL OR (a.communityId IN $cids AND b.communityId IN $cids))
            RETURN a.id AS source, a.communityId AS sc, b.id AS target, b.communityId AS tc, r.score AS score
            ORDER BY r.score DESC
            LIMIT $limit
            """,
            minScore=float(min_score),
            maxScore=float(max_score),
            cids=community_ids or None,
            limit=int(limit),
        )
        return self._to_graph(rows)

    def ego_graph(self, doc_id: str, hops: int, node_limit: int, min_score: float, max_score: float = 1.0) -> dict:
        hops = 2 if hops >= 2 else 1  # literal in the pattern; never interpolate user input
        # The centre is always kept and the node budget is filled nearest-first
        # (1-hop before 2-hop), so a LIMIT can never cut the document the user asked for.
        rows = self._read(
            f"""
            MATCH (c:Document {{id: $id}})
            OPTIONAL MATCH p = (c)-[:SIMILAR_TO*1..{hops}]-(n:Document)
            WHERE n <> c
            WITH c, n, min(length(p)) AS dist
            ORDER BY dist
            WITH c, [x IN collect(n) WHERE x IS NOT NULL] AS found
            WITH [c] + found[..($nodeLimit - 1)] AS ns
            UNWIND ns AS a
            MATCH (a)-[r:SIMILAR_TO]->(b:Document)
            WHERE b IN ns AND r.score >= $minScore AND r.score <= $maxScore
            RETURN a.id AS source, a.communityId AS sc, b.id AS target, b.communityId AS tc, r.score AS score
            """,
            id=doc_id,
            nodeLimit=int(node_limit),
            minScore=float(min_score),
            maxScore=float(max_score),
        )
        graph = self._to_graph(rows)
        if not any(node["id"] == doc_id for node in graph["nodes"]):
            center = self._read("MATCH (d:Document {id: $id}) RETURN d.communityId AS c", id=doc_id)
            if center:
                graph["nodes"].append({"id": doc_id, "community_id": center[0]["c"]})
        return graph

    def subgraph(
        self, ids: list[str], expand: bool, neighbor_limit: int, min_score: float, max_score: float = 1.0
    ) -> dict:
        """The graph induced by a set of seed documents (a search result, a filter).

        Every seed that exists is a node even when it has no edge — an isolated match
        is still a match, and dropping it would make the picture disagree with the list
        it was built from. With ``expand`` the strongest 1-hop neighbours (by their best
        edge to any seed) are added up to ``neighbor_limit``; links are then every
        SIMILAR_TO edge inside the final node set.
        """
        if not ids:
            return {"nodes": [], "links": []}
        seeds = self._read(
            "MATCH (d:Document) WHERE d.id IN $ids RETURN d.id AS id, d.communityId AS c",
            ids=ids,
        )
        community = {row["id"]: row["c"] for row in seeds}
        order = [i for i in dict.fromkeys(ids) if i in community]
        if expand and neighbor_limit > 0:
            neighbours = self._read(
                """
                MATCH (s:Document)-[r:SIMILAR_TO]-(n:Document)
                WHERE s.id IN $ids AND NOT n.id IN $ids AND r.score >= $minScore AND r.score <= $maxScore
                WITH n, max(r.score) AS best
                ORDER BY best DESC, n.id
                LIMIT $limit
                RETURN n.id AS id, n.communityId AS c
                """,
                ids=order,
                minScore=float(min_score),
                maxScore=float(max_score),
                limit=int(neighbor_limit),
            )
            for row in neighbours:
                if row["id"] not in community:
                    community[row["id"]] = row["c"]
                    order.append(row["id"])
        links = self._read(
            """
            MATCH (a:Document)-[r:SIMILAR_TO]->(b:Document)
            WHERE a.id IN $ids AND b.id IN $ids AND r.score >= $minScore AND r.score <= $maxScore
            RETURN a.id AS source, b.id AS target, r.score AS score
            ORDER BY r.score DESC
            """,
            ids=order,
            minScore=float(min_score),
            maxScore=float(max_score),
        )
        return {
            "nodes": [{"id": i, "community_id": community[i]} for i in order],
            "links": [{"source": r["source"], "target": r["target"], "score": float(r["score"])} for r in links],
        }

    @staticmethod
    def _to_graph(rows: list[dict]) -> dict:
        nodes: dict[str, dict] = {}
        links = []
        for row in rows:
            nodes[row["source"]] = {"id": row["source"], "community_id": row["sc"]}
            nodes[row["target"]] = {"id": row["target"], "community_id": row["tc"]}
            links.append({"source": row["source"], "target": row["target"], "score": float(row["score"])})
        return {"nodes": list(nodes.values()), "links": links}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
