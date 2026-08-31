-- Find any research report that cites a source that was originally written by me
SELECT
    report.title AS report_title,
    source.url AS cited_url,
    source.original_author AS author
FROM research_report
WHERE ->cites->web_source.original_author = 'Me'
OR ->cites->web_source.content_hash IN (SELECT content_hash FROM my_local_nodes);