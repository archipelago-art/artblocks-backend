const ethers = require("ethers");

const { ObjectType, newId } = require("./id");

function canonicalForm(clauses) {
  if (clauses.length === 0) {
    throw new Error("empty cnf disallowed");
  }
  const cleanedClauses = clauses.map((x) => {
    if (x.length === 0) {
      throw new Error("empty clause disallowed");
    }
    const deduped = Array.from(new Set(x));
    deduped.sort();
    return deduped;
  });
  const dedupedClauses = [];
  const seen = new Set();
  for (const x of cleanedClauses) {
    const s = String(x);
    if (seen.has(s)) {
      continue;
    }
    seen.add(s);
    dedupedClauses.push(x);
  }
  dedupedClauses.sort();
  return dedupedClauses;
}

function matchesCnf(tokenTraits /*: Set<T> */, clauses /*: T[][] */) {
  return clauses.every((clause) =>
    clause.some((trait) => tokenTraits.has(trait))
  );
}

async function addCnf({
  client,
  clauses /** An array of arrays of traitids */,
}) {
  clauses = canonicalForm(clauses);

  await client.query("BEGIN");
  const cnfId = newId(ObjectType.CNF);
  const traits = Array.from(new Set(clauses.flat()));
  const projectId = await projectIdForTraits(client, traits);

  const canonicalFormText = JSON.stringify(clauses);
  const canonicalFormBytes = ethers.utils.toUtf8Bytes(canonicalFormText);
  const digest = ethers.utils
    .sha256(canonicalFormBytes)
    .slice("0x".length + 32);
  const addCnfRes = await client.query(
    `
    INSERT INTO cnfs (cnf_id, project_id, canonical_form, digest)
    VALUES ($1::cnfid, $2::projectid, $3::text, $4::uuid)
    ON CONFLICT (project_id, digest) DO NOTHING
    `,
    [cnfId, projectId, canonicalFormText, digest]
  );
  if (addCnfRes.rowCount === 0) {
    const existingRes = await client.query(
      `
      SELECT cnf_id AS "oldCnfId", canonical_form AS "oldCanonicalForm"
      FROM cnfs
      WHERE project_id = $1 AND digest = $2
      `,
      [projectId, digest]
    );
    const { oldCnfId, oldCanonicalForm } = existingRes.rows[0];
    if (oldCanonicalForm !== canonicalFormText) {
      throw new Error(
        `unexpected digest collision: ${projectId}, ${digest}: ${text} vs ${canonicalForm}`
      );
    }
    await client.query("ROLLBACK");
    return oldCnfId;
  }

  await client.query(
    `
    INSERT INTO cnf_clauses (cnf_id, clause_idx, trait_id)
    VALUES ($1::cnfid, unnest($2::int[]), unnest($3::traitid[]))
    `,
    [
      cnfId,
      clauses.flatMap((clause, clauseIdx) =>
        Array(clause.length).fill(clauseIdx)
      ),
      clauses.flat(),
    ]
  );

  const tokenTraitsRes = await client.query(
    `
    SELECT token_id AS "tokenId", trait_id AS "traitId"
    FROM trait_members
    WHERE trait_id = ANY($1::traitid[])
    `,
    [traits]
  );
  const tokenIdToTraitset = new Map();
  for (const { tokenId, traitId } of tokenTraitsRes.rows) {
    if (!tokenIdToTraitset.has(tokenId)) {
      tokenIdToTraitset.set(tokenId, new Set());
    }
    tokenIdToTraitset.get(tokenId).add(traitId);
  }
  const matchingTokens = [];
  for (const [tokenId, tokenTraits] of tokenIdToTraitset) {
    if (matchesCnf(tokenTraits, clauses)) {
      matchingTokens.push(tokenId);
    }
  }
  await client.query(
    `
    INSERT INTO cnf_members (cnf_id, token_id)
    VALUES ($1, unnest($2::tokenid[]))
    `,
    [cnfId, matchingTokens]
  );

  await client.query("COMMIT");
  return cnfId;
}

async function projectIdForTraits(client, traits) {
  const res = await client.query(
    `
    SELECT DISTINCT project_id AS "id"
    FROM
      unnest($1::traitid[]) AS these_traits(trait_id)
      LEFT OUTER JOIN traits USING (trait_id)
      LEFT OUTER JOIN features USING (feature_id)
    LIMIT 2
    `,
    [traits]
  );
  if (res.rows.length !== 1 || res.rows[0].id == null)
    throw new Error("did not find single unique project id");
  return res.rows[0].id;
}

async function retrieveCnfs({ client, cnfId, projectId }) {
  if ((cnfId == null) === (projectId == null)) {
    throw new Error("must set cnfId xor projectId");
  }
  const res = await client.query(
    `
    SELECT cnf_id AS "cnfId", clause_idx AS "clauseIdx", trait_id AS "traitId"
    FROM cnfs JOIN cnf_clauses USING (cnf_id)
    WHERE true
      AND (project_id = $1 OR $1 IS NULL)
      AND (cnf_id = $2 OR $2 IS NULL)
    ORDER BY cnf_id, clause_idx, trait_id
    `,
    [projectId, cnfId]
  );

  const results = [];
  let lastCnfId = null;
  let thisCnf = null;
  let lastClauseIdx = null;
  let thisClause = null;
  for (const { cnfId, clauseIdx, traitId } of res.rows) {
    if (cnfId !== lastCnfId) {
      lastCnfId = cnfId;
      lastClauseIdx = null;
      thisCnf = { cnfId, clauses: [] };
      results.push(thisCnf);
    }
    if (clauseIdx !== lastClauseIdx) {
      lastClauseIdx = clauseIdx;
      thisClause = [];
      thisCnf.clauses.push(thisClause);
    }
    thisClause.push(traitId);
  }

  // Re-canonicalize, just to be safe.
  for (const cnf of results) {
    cnf.clauses = canonicalForm(cnf.clauses);
  }

  return results;
}

module.exports = {
  canonicalForm,
  addCnf,
  matchesCnf,
  projectIdForTraits,
  retrieveCnfs,
};
