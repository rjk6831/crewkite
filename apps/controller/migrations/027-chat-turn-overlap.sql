-- A step's allowance stands only when no other chat turn on its provider ran between two usage
-- readings. The check asks for the turns of one family that ended at or after the first reading,
-- and for the turns of that family still open. This index answers both by a search on the family
-- and the turn's end, so the check reads only those turns. The expressions match the query's.
CREATE INDEX chat_turns_family_end ON chat_turns(
  json_extract(body, '$.selection.family'),
  json_extract(body, '$.endedAt')
);
