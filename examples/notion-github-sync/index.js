/* ================================================================================

	notion-github-sync.

  Glitch example: https://glitch.com/edit/#!/notion-github-sync
  Find the official Notion API client @ https://github.com/makenotion/notion-sdk-js/

================================================================================ */

const { Client } = require("@notionhq/client")
const dotenv = require("dotenv")
const { Octokit } = require("octokit")
const _ = require("lodash")

dotenv.config()
const octokit = new Octokit({ auth: process.env.GH_KEY })
const notion = new Client({ auth: process.env.NOTION_KEY })

const databaseId = process.env.NOTION_DATABASE_ID
const OPERATION_BATCH_SIZE = 10

/**
 * Local map to store  GitHub issue ID to its Notion pageId.
 * { [issueId: string]: string }
 */
const gitHubIssuesIdToNotionPageId = {}

/**
 * Initialize local data store.
 * Then sync with GitHub.
 */
setInitialGitHubToNotionIdMap().then(syncNotionDatabaseWithGitHub)

/**
 * Get and set the initial data store with issues currently in the database.
 */
async function setInitialGitHubToNotionIdMap() {
  const currentIssues = await getIssuesFromNotionDatabase()
  for (const { pageId, issueNumber } of currentIssues) {
    gitHubIssuesIdToNotionPageId[issueNumber] = pageId
  }
}

async function syncNotionDatabaseWithGitHub() {
  // Get all issues currently in the provided GitHub repository.
  console.log("\nFetching issues from GitHub repository...")
  const issues = await getGitHubIssuesForRepository()
  console.log(`Fetched ${issues.length} issues from GitHub repository.`)

  // Group issues into those that need to be created or updated in the Notion database.
  const { pagesToCreate, pagesToUpdate } = getNotionOperations(issues)

  // Create pages for new issues.
  console.log(`\n${pagesToCreate.length} new issues to add to Notion.`)
  for (const page of pagesToCreate) {
    try {
      await createPages([page])
    } catch (error) {
      console.error(`Error creating page for issue #${page.number}:`, error)
    }
  }

  // Updates pages for existing issues.
  console.log(`\n${pagesToUpdate.length} issues to update in Notion.`)
  await updatePages(pagesToUpdate)

  // Success!
  console.log("\n✅ Notion database is synced with GitHub.")
}

/**
 * Gets pages from the Notion database.
 *
 * @returns {Promise<Array<{ pageId: string, issueNumber: number }>>}
 */
async function getIssuesFromNotionDatabase() {
  const pages = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    })
    pages.push(...results)
    if (!next_cursor) {
      break
    }
    cursor = next_cursor
  }
  console.log(`${pages.length} issues successfully fetched.`)

  const issues = []
  for (const page of pages) {
    const issueNumberPropertyId = page.properties["Issue Number"].id
    const propertyResult = await notion.pages.properties.retrieve({
      page_id: page.id,
      property_id: issueNumberPropertyId,
    })
    issues.push({
      pageId: page.id,
      issueNumber: propertyResult.number,
    })
  }

  return issues
}

/**
 * Gets issues from a GitHub repository. Pull requests are omitted.
 *
 * https://docs.github.com/en/rest/guides/traversing-with-pagination
 * https://docs.github.com/en/rest/reference/issues
 *
 * @returns {Promise<Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>>}
 */
async function getGitHubIssuesForRepository() {
  console.log("Starting to fetch issues from GitHub...");
  const issues = [];
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: process.env.GH_REPO_OWNER,
    repo: process.env.GH_REPO_NAME,
    state: "all",
    per_page: 100,
  });

  console.log("Processing paginated results...");
  for await (const { data } of iterator) {
    console.log(`Processing batch of ${data.length} issues...`);
    for (const issue of data) {
      console.log(`Processing issue #${issue.number}: ${issue.title}`);
      if (!issue.pull_request) {
        // Fetch labels for the current issue using the listLabelsOnIssue method
        const labelsResponse = await octokit.rest.issues.listLabelsOnIssue({
          owner: process.env.GH_REPO_OWNER,
          repo: process.env.GH_REPO_NAME,
          issue_number: issue.number,
        }).catch(error => console.error(`Error fetching labels for issue #${issue.number}:`, error));

        // Check if labelsResponse is valid before proceeding
        if (labelsResponse) {
          const labels = labelsResponse.data.map(label => label.name);
          console.log(`Fetched labels for issue #${issue.number}:`, labels);

          issues.push({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            comment_count: issue.comments,
            url: issue.html_url,
            labels: labels,
          });
        } else {
          console.log(`Skipping label fetching for issue #${issue.number} due to error.`);
        }
      }
    }
  }

  console.log(`Finished fetching issues from GitHub. Total issues fetched: ${issues.length}`);
  return issues;
}

/**
 * Determines which issues already exist in the Notion database.
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} issues
 * @returns {{
 *   pagesToCreate: Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>;
 *   pagesToUpdate: Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>
 * }}
 */
function getNotionOperations(issues) {
  const pagesToCreate = []
  const pagesToUpdate = []
  for (const issue of issues) {
    const pageId = gitHubIssuesIdToNotionPageId[issue.number]
    if (pageId) {
      pagesToUpdate.push({
        ...issue,
        pageId,
      })
    } else {
      pagesToCreate.push(issue)
    }
  }
  return { pagesToCreate, pagesToUpdate }
}

/**
 * Creates new pages in Notion.
 *
 * https://developers.notion.com/reference/post-page
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToCreate
 */
async function createPages(pagesToCreate) {
  const pagesToCreateChunks = _.chunk(pagesToCreate, OPERATION_BATCH_SIZE)
  for (const pagesToCreateBatch of pagesToCreateChunks) {
    await Promise.all(
      pagesToCreateBatch.map(issue =>
        notion.pages.create({
          parent: { database_id: databaseId },
          properties: getPropertiesFromIssue(issue),
        })
      )
    )
    console.log(`Completed batch size: ${pagesToCreateBatch.length}`)
  }
}

/**
 * Updates provided pages in Notion.
 *
 * https://developers.notion.com/reference/patch-page
 *
 * @param {Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string, labels: string[] }>} pagesToUpdate
 */
async function updatePages(pagesToUpdate) {
  const pagesToUpdateChunks = _.chunk(pagesToUpdate, OPERATION_BATCH_SIZE);

  for (const pagesToUpdateBatch of pagesToUpdateChunks) {
    await Promise.all(pagesToUpdateBatch.map(async ({ pageId, ...issue }) => {
      await updatePageWithRetry(pageId, getPropertiesFromIssue(issue));
    }));
    console.log(`Completed batch size: ${pagesToUpdateBatch.length}`);
  }
}

/**
 * Attempts to update a page with retry logic on conflict error.
 *
 * @param {string} pageId
 * @param {Object} properties
 * @param {number} [retries=3]
 */
async function updatePageWithRetry(pageId, properties, retries = 3) {
 try {
   await notion.pages.update({
     page_id: pageId,
     properties: properties,
   });
 } catch (error) {
   if (error.code === 'conflict_error' && retries > 0) {
     console.log(`Conflict error for page ${pageId}. Retrying... ${retries} retries left.`);
     await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
     await updatePageWithRetry(pageId, properties, retries - 1);
   } else {
     throw error;
   }
 }
}

//*========================================================================
// Helpers
//*========================================================================

/**
 * Returns the GitHub issue to conform to this database's schema properties.
 *
 * @param {{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string, labels: string[] }} issue
 */
function getPropertiesFromIssue(issue) {
  const { title, number, state, comment_count, url, labels } = issue;
  return {
    Name: {
      title: [{ type: "text", text: { content: title } }],
    },
    "Issue Number": {
      number,
    },
    State: {
      select: { name: state },
    },
    "Number of Comments": {
      number: comment_count,
    },
    "Issue URL": {
      url,
    },
    "Type": {
      multi_select: labels.map(label => ({ name: label })),
    },
  };
}
