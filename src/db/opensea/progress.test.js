const { setLastUpdated, getLastUpdated } = require("./progress");
const { testDbProvider } = require("../testUtil");
const { parseProjectData } = require("../../scrape/fetchArtblocksProject");
const artblocks = require("../artblocks");
const snapshots = require("../../scrape/snapshots");

describe("db/opensea/progress", () => {
  const withTestDb = testDbProvider();
  const sc = new snapshots.SnapshotCache();

  async function exampleProject(client) {
    const project = parseProjectData(
      snapshots.ARCHETYPE,
      await sc.project(snapshots.ARCHETYPE)
    );
    const projectId = await artblocks.addProject({
      client,
      project,
    });
    return {
      project,
      projectId,
    };
  }

  it(
    "last updated is null if never set for a slug",
    withTestDb(async ({ client }) => {
      const slug = "awesome-drop-by-archipelago";
      const { projectId } = await exampleProject(client);
      const result = await getLastUpdated({ client, slug, projectId });
      expect(result).toEqual(null);
    })
  );
  it(
    "last updated may be set and retrieved",
    withTestDb(async ({ client }) => {
      const { projectId } = await exampleProject(client);
      const slug = "awesome-drop-by-archipelago";
      const until = new Date("2021-01-01");
      await setLastUpdated({ client, slug, until, projectId });
      const result = await getLastUpdated({ client, slug, projectId });
      expect(result).toEqual(until);
    })
  );
  it(
    "project ids are set",
    withTestDb(async ({ client }) => {
      const { projectId } = await exampleProject(client);
      const slug = "awesome-drop-by-archipelago";
      const until = new Date("2021-01-01");
      await setLastUpdated({ client, slug, until, projectId });
      const res = await client.query(
        `SELECT project_id AS "projectId" FROM opensea_progress LIMIT 1`
      );
      expect(res.rows[0]).toEqual({ projectId });
    })
  );
});
