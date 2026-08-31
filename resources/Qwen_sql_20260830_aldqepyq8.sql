-- Find messages similar to the query, and return their parent/children for context
SELECT
    *,
    (SELECT * FROM <-replied_to LIMIT 1) AS parent_message,
    (SELECT * FROM ->replied_to LIMIT 3) AS child_messages,
    (SELECT ->discusses->concept.name FROM _) AS tags
FROM message
WHERE embedding <|1.5|> $query_embedding
ORDER BY similarity DESC
LIMIT 10;