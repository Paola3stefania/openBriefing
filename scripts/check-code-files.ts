/**
 * Script to check CodeFile table and show file paths stored in database
 */

import { prisma, closePrisma } from "../src/storage/db/prisma.js";

async function checkCodeFiles() {
  try {
    console.log("Querying CodeFile table...\n");

    // Get all code files with their details
    const codeFiles = await prisma.codeFile.findMany({
      select: {
        id: true,
        filePath: true,
        fileName: true,
        language: true,
        contentHash: true,
        lastIndexedAt: true,
        codeSearchId: true,
        codeSearch: {
          select: {
            searchQuery: true,
            repositoryUrl: true,
          },
        },
        _count: {
          select: {
            codeSections: true,
          },
        },
      },
      orderBy: {
        lastIndexedAt: "desc",
      },
      take: 50, // Show first 50 files
    });

    console.log(`Found ${codeFiles.length} code files in database\n`);
    console.log("=".repeat(80));
    console.log("FILE PATHS IN DATABASE:");
    console.log("=".repeat(80));

    if (codeFiles.length === 0) {
      console.log("No code files found in database.");
    } else {
      // Group by repository
      const byRepo = new Map<string, typeof codeFiles>();
      for (const file of codeFiles) {
        const repo = file.codeSearch?.repositoryUrl || "unknown";
        if (!byRepo.has(repo)) {
          byRepo.set(repo, []);
        }
        byRepo.get(repo)!.push(file);
      }

      for (const [repo, files] of byRepo.entries()) {
        console.log(`\nRepository: ${repo}`);
        console.log("-".repeat(80));
        
        for (const file of files) {
          console.log(`\n  Path: "${file.filePath}"`);
          console.log(`  File Name: ${file.fileName}`);
          console.log(`  Language: ${file.language || "unknown"}`);
          console.log(`  Sections: ${file._count.codeSections}`);
          console.log(`  Search Query: "${file.codeSearch?.searchQuery || "N/A"}"`);
          console.log(`  Last Indexed: ${file.lastIndexedAt.toISOString()}`);
          console.log(`  Hash: ${file.contentHash.substring(0, 16)}...`);
        }
      }

      // Show path patterns
      console.log("\n" + "=".repeat(80));
      console.log("PATH PATTERN ANALYSIS:");
      console.log("=".repeat(80));
      
      const pathPatterns = {
        absolute: 0,
        relative: 0,
        leadingSlash: 0,
        windows: 0,
        demo: 0,
      };

      const samplePaths: string[] = [];
      
      for (const file of codeFiles) {
        const path = file.filePath;
        samplePaths.push(path);
        
        if (path.startsWith("/")) {
          pathPatterns.leadingSlash++;
        }
        if (path.includes("\\")) {
          pathPatterns.windows++;
        }
        if (path.match(/^[A-Z]:/)) {
          pathPatterns.absolute++;
        }
        if (path.toLowerCase().includes("demo")) {
          pathPatterns.demo++;
        }
        if (!path.startsWith("/") && !path.match(/^[A-Z]:/)) {
          pathPatterns.relative++;
        }
      }

      console.log(`\nTotal files analyzed: ${codeFiles.length}`);
      console.log(`  Relative paths: ${pathPatterns.relative}`);
      console.log(`  Absolute paths: ${pathPatterns.absolute}`);
      console.log(`  Leading slash: ${pathPatterns.leadingSlash}`);
      console.log(`  Windows separators: ${pathPatterns.windows}`);
      console.log(`  Contains "demo": ${pathPatterns.demo}`);

      console.log("\n" + "=".repeat(80));
      console.log("SAMPLE PATHS (first 20):");
      console.log("=".repeat(80));
      for (const path of samplePaths.slice(0, 20)) {
        console.log(`  "${path}"`);
      }
    }

    // Get total count
    const totalCount = await prisma.codeFile.count();
    console.log(`\n\nTotal code files in database: ${totalCount}`);
    
    // Get unique file paths count
    const uniquePaths = await prisma.codeFile.groupBy({
      by: ["filePath"],
      _count: true,
    });
    console.log(`Unique file paths: ${uniquePaths.length}`);

  } catch (error) {
    console.error("Error querying database:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
  } finally {
    await closePrisma();
  }
}

checkCodeFiles();

