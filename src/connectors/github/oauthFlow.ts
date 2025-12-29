/**
 * GitHub OAuth Flow Handler
 * Generates tokens via OAuth - tokens are kept in memory only (no persistence)
 */

import { createServer } from "http";
import { parse } from "url";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Run OAuth flow and automatically get a new token
 * Returns the new token or null if failed
 */
export async function getNewTokenViaOAuth(
  clientId: string,
  clientSecret: string,
  port = 3000
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const REDIRECT_URI = `http://localhost:${port}/callback`;
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=public_repo&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    console.error(`[OAuth] Starting OAuth flow for client ID: ${clientId.substring(0, 12)}...`);
    console.error(`[OAuth] Authorization URL: ${authUrl}`);
    console.error(`[OAuth] Opening browser for authorization...`);

    // Open browser
    const platform = process.platform;
    let openCommand: string;
    if (platform === "darwin") {
      openCommand = "open";
    } else if (platform === "linux") {
      openCommand = "xdg-open";
    } else if (platform === "win32") {
      openCommand = "start";
    } else {
      console.error(`[OAuth] Unsupported platform. Please visit: ${authUrl}`);
      reject(new Error("Unsupported platform"));
      return;
    }

    execAsync(`${openCommand} "${authUrl}"`).catch(() => {
      console.error(`[OAuth] Could not open browser automatically. Please visit: ${authUrl}`);
    });

    // Create server to handle callback
    const server = createServer(async (req, res) => {
      const { query } = parse(req.url || "", true);
      const code = query.code as string;

      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      try {
        // Exchange code for token
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.error) {
          res.writeHead(400);
          res.end(`Error: ${tokenData.error_description || tokenData.error}`);
          reject(new Error(tokenData.error_description || tokenData.error));
          return;
        }

        const accessToken = tokenData.access_token;

        // Verify token works
        const userResponse = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        });

        if (!userResponse.ok) {
          const errorText = await userResponse.text();
          const statusText = userResponse.statusText;
          const status = userResponse.status;
          console.error(`[OAuth] Token verification failed: ${status} ${statusText}`);
          console.error(`[OAuth] Error response: ${errorText}`);
          throw new Error(`Failed to verify token: ${status} ${statusText}. ${errorText}`);
        }

        const userData = await userResponse.json();

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <head><title>Token Generated</title></head>
            <body style="font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto;">
              <h1>Token Generated Successfully!</h1>
              <p>Authorized as: <strong>${userData.login}</strong></p>
              <p>The token will be used for this session (in memory only).</p>
              <p style="color: #666; margin-top: 30px;">You can close this window.</p>
            </body>
          </html>
        `);

        console.error(`[OAuth] Token generated successfully for ${userData.login}`);
        
        // Token is returned to caller - no persistence needed (kept in memory only)
        
        // Close server
        setTimeout(() => {
          server.close();
          resolve(accessToken);
        }, 1000);
      } catch (error) {
        res.writeHead(500);
        res.end(`Error: ${error instanceof Error ? error.message : String(error)}`);
        console.error("[OAuth] Error:", error);
        server.close();
        reject(error);
      }
    });

    server.listen(port, () => {
      console.error(`[OAuth] Server listening on http://localhost:${port}`);
      console.error(`[OAuth] Waiting for authorization...`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      console.error(`[OAuth] Timeout: No authorization received for client ${clientId.substring(0, 8)}...`);
      server.close();
      reject(new Error("OAuth timeout"));
    }, 5 * 60 * 1000);
  });
}

