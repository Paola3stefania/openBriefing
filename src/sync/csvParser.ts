/**
 * CSV Parser for Organization Members
 * Parses CSV file with team members and extracts relevant information
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { log, logError } from "../mcp/logger.js";

export interface OrganizationMember {
  name: string;
  email: string;
  role: string;
  teams: string[];
  active: boolean;
  githubUsername?: string; // Optional - if CSV has GitHub column
}

/**
 * Parse CSV file with organization members
 * Expected columns: Name, Email, Role, Teams, Active, (optional: GitHub)
 */
export async function parseMembersCSV(csvPath?: string): Promise<OrganizationMember[]> {
  const path = csvPath || join(process.cwd(), "members.csv");
  
  try {
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(line => line.trim().length > 0);
    
    if (lines.length < 2) {
      log(`[CSV] No data rows found in ${path}`);
      return [];
    }

    // Parse header
    const header = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    const nameIdx = header.findIndex(h => h.toLowerCase() === "name");
    const emailIdx = header.findIndex(h => h.toLowerCase() === "email");
    const roleIdx = header.findIndex(h => h.toLowerCase() === "role");
    const teamsIdx = header.findIndex(h => h.toLowerCase() === "teams");
    const activeIdx = header.findIndex(h => h.toLowerCase() === "active");
    const githubIdx = header.findIndex(h => h.toLowerCase().includes("github") || h.toLowerCase() === "github username");

    if (emailIdx === -1) {
      throw new Error("CSV must have an 'Email' column");
    }

    const members: OrganizationMember[] = [];

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVRow(lines[i]);
      
      if (row.length === 0) continue;

      const email = row[emailIdx]?.trim().replace(/^"|"$/g, "");
      if (!email) continue;

      const name = nameIdx >= 0 ? row[nameIdx]?.trim().replace(/^"|"$/g, "") : "";
      const role = roleIdx >= 0 ? row[roleIdx]?.trim().replace(/^"|"$/g, "") : "";
      const teamsStr = teamsIdx >= 0 ? row[teamsIdx]?.trim().replace(/^"|"$/g, "") : "";
      const activeStr = activeIdx >= 0 ? row[activeIdx]?.trim().replace(/^"|"$/g, "").toLowerCase() : "active";
      const githubUsername = githubIdx >= 0 ? row[githubIdx]?.trim().replace(/^"|"$/g, "") : undefined;

      const teams = teamsStr ? teamsStr.split(";").map(t => t.trim()).filter(Boolean) : [];
      const active = activeStr === "active";

      members.push({
        name,
        email,
        role,
        teams,
        active,
        githubUsername,
      });
    }

    log(`[CSV] Parsed ${members.length} members from ${path}`);
    return members;

  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      log(`[CSV] File not found: ${path} (this is okay if you're using manual configuration)`);
      return [];
    }
    logError(`[CSV] Failed to parse CSV file ${path}:`, error);
    return [];
  }
}

/**
 * Parse a CSV row handling quoted fields with commas
 */
function parseCSVRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  // Add last field
  result.push(current);
  return result;
}

/**
 * Get organization engineer emails from CSV
 * Filters to active members only
 */
export async function getOrganizationEngineerEmails(csvPath?: string): Promise<string[]> {
  const members = await parseMembersCSV(csvPath);
  return members
    .filter(m => m.active)
    .map(m => m.email.toLowerCase());
}

/**
 * Get organization engineer GitHub usernames from CSV
 * Returns map of email -> GitHub username
 */
export async function getOrganizationEngineerGitHubMap(csvPath?: string): Promise<Map<string, string>> {
  const members = await parseMembersCSV(csvPath);
  const map = new Map<string, string>();

  for (const member of members) {
    if (member.active && member.githubUsername) {
      map.set(member.email.toLowerCase(), member.githubUsername.toLowerCase());
    }
  }

  return map;
}

