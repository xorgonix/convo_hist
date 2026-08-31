-- Define the tables
DEFINE TABLE conversation SCHEMALESS;
DEFINE TABLE message SCHEMALESS;
DEFINE TABLE concept SCHEMALESS; -- Ontology node
DEFINE TABLE semantic_skeleton SCHEMALESS;
DEFINE TABLE chat_message SCHEMALESS;
DEFINE TABLE yt_transcript_segment SCHEMALESS;
DEFINE TABLE research_report SCHEMALESS;

-- Define the graph relationships (Edges)
DEFINE EDGE replied_to SCHEMALESS;   -- Chat Tree
DEFINE EDGE is_child_of SCHEMALESS;  -- Ontology Hierarchy
DEFINE EDGE discusses SCHEMALESS;    -- Tags
DEFINE EDGE represents SCHEMALESS;   -- Messy reality to clean skeleton
DEFINE EDGE sourced_from SCHEMALESS; -- Provenance: Origin
DEFINE EDGE synthesized_by SCHEMALESS; -- Provenance: AI Process
DEFINE EDGE refines SCHEMALESS;      -- Provenance: Evolution
DEFINE EDGE verified_by SCHEMALESS;  -- Provenance: Human verification
DEFINE EDGE cites SCHEMALESS;        -- Citations

-- Vector Indexing
DEFINE INDEX message_embedding_idx ON message FIELDS embedding VECTOR DIMENSION 1536;