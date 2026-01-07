import { auditAndFixIncorrectlyAssignedIssues } from "../src/sync/prBasedSync.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Running audit${dryRun ? " (DRY RUN)" : ""}...`);
  
  const result = await auditAndFixIncorrectlyAssignedIssues({ dryRun });
  
  console.log(JSON.stringify(result, null, 2));
  
  process.exit(result.errors > 0 ? 1 : 0);
}

main().catch(console.error);
