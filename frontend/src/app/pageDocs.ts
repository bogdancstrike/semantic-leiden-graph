import type { PageDocEntry } from '@/components/PageDoc'

/** Each page's footer documentation: a few words per facet, the sentence on hover. */
export const PAGE_DOCS: Record<'overview' | 'explore' | 'graph' | 'communities' | 'import' | 'operations', PageDocEntry> = {
  overview: {
    what: 'Corpus health at a glance',
    flow: 'Stats → KPIs → drill-down',
    tech: 'ECharts, Elasticsearch, Neo4j',
    why: 'Spot problems early',
    how: 'Click any tile or bar',
    details: {
      what: 'Counts, clustering quality and distributions of the whole corpus on one screen.',
      flow: 'GET /stats, /communities, /cluster/runs and /explore/insights feed the tiles and charts; every tile links to the view behind it.',
      tech: 'ECharts (core build) themed from the same design tokens as AntD; numbers come from Elasticsearch aggregations and Neo4j.',
      why: 'Unclustered documents, inconsistent stores or a weak modularity are visible before anyone searches.',
      how: 'Tiles and chart bars are clickable and open the documents, communities or graph they summarise.',
    },
  },
  explore: {
    what: 'Search and filter documents',
    flow: 'Query → ES + Qdrant → fuse',
    tech: 'Elasticsearch, Qdrant, RAQB',
    why: 'Precise, explainable retrieval',
    how: 'Type, refine, open',
    details: {
      what: 'Browse every document, or rank them by keyword (BM25), semantic (vectors) or hybrid relevance.',
      flow: 'Conditions compile to an Elasticsearch bool query; in semantic mode they pre-filter Qdrant by id; hybrid fuses both lists with RRF or DBSF.',
      tech: 'react-awesome-query-builder edits the condition tree; Elasticsearch runs filters and BM25; Qdrant runs HNSW vector search.',
      why: 'Every result says which engine found it and which Leiden community it belongs to.',
      how: 'Type a query, pick how to match, add conditions under Advanced, click a row to open the document.',
    },
  },
  graph: {
    what: 'See similarity neighbourhoods',
    flow: 'Neo4j edges → d3 layout',
    tech: 'Neo4j, d3-force, Canvas',
    why: 'See how topics connect',
    how: 'Choose source, highlight, drag',
    details: {
      what: 'The k-nearest-neighbour similarity graph Leiden clusters; colour is the community.',
      flow: 'Edges come from Neo4j (strongest links, communities, a neighbourhood or the documents a search returns); d3-force lays them out on a canvas.',
      tech: 'Canvas + d3-force keep thousands of nodes interactive; highlight conditions are evaluated in the browser.',
      why: 'Bridges between communities and isolated documents are findings a table cannot show.',
      how: 'Pick what to draw, highlight nodes with conditions, click a node for details, double-click to open it.',
    },
  },
  communities: {
    what: 'Inspect Leiden topic clusters',
    flow: 'Graph metrics → table, charts',
    tech: 'Neo4j GDS Leiden',
    why: 'Judge cluster quality',
    how: 'Search a topic, filter metrics',
    details: {
      what: 'Every community (at least two documents) with its size, cohesion, density and conductance, and its most central documents.',
      flow: 'Metrics come from the graph structure in Neo4j; topic search votes communities from semantic anchors (Qdrant) and hits.',
      tech: 'Weighted Leiden (Neo4j Graph Data Science); metric conditions are evaluated in the browser.',
      why: 'A well separated community has high cohesion and low conductance; bridges suggest topics that could merge.',
      how: 'Ask which communities discuss a topic, narrow by metrics under Advanced, expand a row for its documents.',
    },
  },
  import: {
    what: 'Load CSV documents',
    flow: 'Upload → embed → link → cluster',
    tech: 'FastAPI, ES, Qdrant, Neo4j',
    why: 'Bulk, idempotent ingestion',
    how: 'Drop, map columns, import',
    details: {
      what: 'Upload a CSV; each row becomes a document. Extra columns are kept as filterable metadata.',
      flow: 'The file streams to the API, a background job indexes it in Elasticsearch, embeds it into Qdrant, links neighbours in Neo4j and runs Leiden.',
      tech: 'XHR upload with progress, FastAPI background jobs, sentence-transformers embeddings.',
      why: 'Rows are upserted by id: re-importing a file changes nothing, edited rows are re-embedded.',
      how: 'Drop a file, check which column is the id and the text, choose options, and follow the progress — it survives leaving the page.',
    },
  },
  operations: {
    what: 'Run maintenance jobs',
    flow: 'Job queue → three stores',
    tech: 'Background jobs, Leiden',
    why: 'Keep stores consistent',
    how: 'Pick a job, confirm, watch',
    details: {
      what: 'Re-cluster, rebuild the similarity graph, reconcile stores and delete whole data sources.',
      flow: 'Jobs run one at a time in the API process; Elasticsearch is the source of truth, Qdrant and Neo4j are rebuilt from it.',
      tech: 'In-process job runner with cooperative cancellation; Neo4j GDS Leiden; Qdrant and Elasticsearch bulk APIs.',
      why: 'The graph is never rebuilt and clustered concurrently, and a partial failure is always repairable.',
      how: 'Set the parameters, start the job and follow its phases; progress survives reloads.',
    },
  },
}
