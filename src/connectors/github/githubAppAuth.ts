/**
 * GitHub App Authentication
 * Handles JWT generation and installation token fetching
 */

import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { existsSync } from "fs";
import { log } from "../../mcp/logger.js";

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number; // timestamp in ms
}

/**
 * GitHub App Authentication Manager
 * Manages installation tokens for GitHub Apps
 */
export class GitHubAppAuth {
  private appId: string;
  private installationId: string;
  private privateKey: string;
  private auth: ReturnType<typeof createAppAuth>;
  private cachedToken: InstallationToken | null = null;
  private readonly TOKEN_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

  constructor(config: GitHubAppConfig) {
    this.appId = config.appId;
    this.installationId = config.installationId;

    // Load private key from file
    if (!existsSync(config.privateKeyPath)) {
      throw new Error(`Private key file not found: ${config.privateKeyPath}`);
    }

    try {
      this.privateKey = readFileSync(config.privateKeyPath, "utf-8");
    } catch (error) {
      throw new Error(`Failed to read private key file: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Initialize Octokit auth
    this.auth = createAppAuth({
      appId: this.appId,
      privateKey: this.privateKey,
      installationId: parseInt(this.installationId),
    });

    log(`[GitHub App Auth] Initialized for App ID ${this.appId}, Installation ID ${this.installationId}`);
  }

  /**
   * Get a valid installation access token
   * Automatically refreshes if token is expired or about to expire
   */
  async getInstallationToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - this.TOKEN_BUFFER_MS) {
      return this.cachedToken.token;
    }

    // Fetch new token
    try {
      log(`[GitHub App Auth] Fetching new installation token...`);
      const authResult = await this.auth({ type: "installation" });
      
      if (!authResult.token) {
        throw new Error("Failed to get installation token from GitHub App");
      }

      // Tokens are valid for 1 hour (3600 seconds)
      // Set expiry to 55 minutes to be safe
      const expiresAt = Date.now() + (55 * 60 * 1000);

      this.cachedToken = {
        token: authResult.token,
        expiresAt,
      };

      log(`[GitHub App Auth] Successfully obtained installation token (expires in ~55 minutes)`);
      return authResult.token;
    } catch (error) {
      log(`[GitHub App Auth] Error fetching installation token: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Check if token is valid (not expired)
   */
  isTokenValid(): boolean {
    return this.cachedToken !== null && Date.now() < this.cachedToken.expiresAt - this.TOKEN_BUFFER_MS;
  }

  /**
   * Force refresh the token (clear cache and fetch new one)
   */
  async refreshToken(): Promise<string> {
    this.cachedToken = null;
    return this.getInstallationToken();
  }

  /**
   * Get installation ID
   */
  getInstallationId(): string {
    return this.installationId;
  }

  /**
   * Get app ID
   */
  getAppId(): string {
    return this.appId;
  }

  /**
   * Create GitHub App Auth from environment variables
   * Supports comma-separated installation IDs for multiple installations
   * Returns null if not configured
   */
  static fromEnvironment(): GitHubAppAuth | null {
    const appId = process.env.GITHUB_APP_ID;
    const installationIdEnv = process.env.GITHUB_APP_INSTALLATION_ID;
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    if (!appId || !installationIdEnv || !privateKeyPath) {
      return null;
    }

    // For now, use the first installation ID
    // TODO: Support multiple installations (comma-separated)
    const installationIds = installationIdEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
    if (installationIds.length === 0) {
      return null;
    }

    // Use first installation ID
    const installationId = installationIds[0];

    try {
      return new GitHubAppAuth({
        appId,
        installationId,
        privateKeyPath,
      });
    } catch (error) {
      log(`[GitHub App Auth] Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Create multiple GitHub App Auth instances from environment
   * Supports multiple installations (comma-separated)
   */
  static fromEnvironmentMultiple(): GitHubAppAuth[] {
    const appId = process.env.GITHUB_APP_ID;
    const installationIdEnv = process.env.GITHUB_APP_INSTALLATION_ID;
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    if (!appId || !installationIdEnv || !privateKeyPath) {
      return [];
    }

    const installationIds = installationIdEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
    if (installationIds.length === 0) {
      return [];
    }

    const apps: GitHubAppAuth[] = [];

    for (const installationId of installationIds) {
      try {
        const app = new GitHubAppAuth({
          appId,
          installationId,
          privateKeyPath,
        });
        apps.push(app);
      } catch (error) {
        log(`[GitHub App Auth] Failed to initialize for installation ${installationId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return apps;
  }
}

