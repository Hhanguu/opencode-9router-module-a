/**
 * MODULE A — Docker Compose Driver
 * Revision 17 — Implementation
 * 
 * Implements:
 * - docker compose up/stop commands (§5.3.10)
 * - Port conflict detection (Q3)
 * - Verify-then-act pattern for stale-owner narrowing (§5.3)
 */

import { exec } from "child_process"
import { promisify } from "util"
import { readFile } from "fs/promises"
import path from "path"

const execAsync = promisify(exec)

export interface ComposeConfig {
  project: string
  composeFile: string
  baseURL: string
  port: number
}

/**
 * Check if Docker is available
 */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execAsync("docker --version")
    return true
  } catch {
    return false
  }
}

/**
 * Check if port is in use and probe for 9router
 */
export async function checkPortConflict(port: number, baseURL: string): Promise<{
  conflict: boolean
  is9router: boolean
}> {
  try {
    // Try to probe /v1/models
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    const response = await fetch(`${baseURL}/v1/models`, {
      method: "GET",
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (response.ok) {
      const data = await response.json()
      // Check if it looks like 9router response
      if (data && typeof data === "object" && "data" in data && Array.isArray(data.data)) {
        return { conflict: true, is9router: true }
      }
    }

    // Something is listening but not 9router-shaped
    return { conflict: true, is9router: false }
  } catch {
    // Nothing listening
    return { conflict: false, is9router: false }
  }
}

/**
 * Start 9router container (§5.3.10)
 * Uses verify-then-act: reads token before compose up
 */
export async function composeUp(
  config: ComposeConfig,
  opts: { lockToken: string; lockDir: string },
): Promise<{ success: boolean; error?: unknown }> {
  try {
    // Verify-then-act: check token before launching
    const currentToken = await readCurrentToken(opts.lockDir)
    if (currentToken !== opts.lockToken) {
      return {
        success: false,
        error: new Error(`Token mismatch: expected ${opts.lockToken}, got ${currentToken}`),
      }
    }

    const cmd = `docker compose -f ${config.composeFile} -p ${config.project} up -d`
    await execAsync(cmd, { timeout: 60_000 })

    return { success: true }
  } catch (err) {
    return { success: false, error: err }
  }
}

/**
 * Stop 9router container (§5.4)
 * Uses verify-then-act: checks token before stopping
 */
export async function composeStop(
  config: ComposeConfig,
  opts: { lockToken: string; lockDir: string },
): Promise<{ success: boolean; error?: unknown }> {
  try {
    // Verify-then-act
    const currentToken = await readCurrentToken(opts.lockDir)
    if (currentToken !== opts.lockToken) {
      return {
        success: false,
        error: new Error(`Token mismatch: expected ${opts.lockToken}, got ${currentToken}`),
      }
    }

    const cmd = `docker compose -f ${config.composeFile} -p ${config.project} stop`
    await execAsync(cmd, { timeout: 30_000 })

    return { success: true }
  } catch (err) {
    return { success: false, error: err }
  }
}

/**
 * Check if container is running
 */
export async function isContainerRunning(project: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker compose -p ${project} ps --status running --format json`)
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Read current lock token from meta.json
 */
async function readCurrentToken(lockDir: string): Promise<string | null> {
  try {
    const metaPath = path.join(lockDir, "meta.json")
    const content = await readFile(metaPath, "utf8")
    const meta = JSON.parse(content)
    return meta.token || null
  } catch {
    return null
  }
}
