import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../pipeline/utils";

export class PersistenceMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceMigrationError";
  }
}

export interface MigrationReadResult<T> {
  value: T;
  migratedFrom?: number;
  migratedTo: number;
}

function recordValue(raw: unknown, format: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PersistenceMigrationError(`${format} must be a JSON object.`);
  return raw as Record<string, unknown>;
}

export function detectVersion(raw: unknown, format: string, versionField: string) {
  const version = recordValue(raw, format)[versionField];
  if (!Number.isInteger(version) || Number(version) < 1) {
    throw new PersistenceMigrationError(`${format} has no valid integer ${versionField}.`);
  }
  return Number(version);
}

export function readVersionedFormat<T>(input: {
  raw: unknown;
  format: string;
  versionField: string;
  currentVersion: number;
  migrations: Record<number, (value: Record<string, unknown>) => Record<string, unknown>>;
  schema: z.ZodType<T>;
}): MigrationReadResult<T> {
  const originalVersion = detectVersion(input.raw, input.format, input.versionField);
  if (originalVersion > input.currentVersion) {
    throw new PersistenceMigrationError(`${input.format} version ${originalVersion} is newer than supported version ${input.currentVersion}. Upgrade scene-gen before reading it.`);
  }
  let version = originalVersion;
  let value = structuredClone(recordValue(input.raw, input.format));
  while (version < input.currentVersion) {
    const migrate = input.migrations[version];
    if (!migrate) throw new PersistenceMigrationError(`${input.format} version ${version} cannot be migrated to version ${input.currentVersion}.`);
    value = migrate(value);
    const nextVersion = detectVersion(value, input.format, input.versionField);
    if (nextVersion !== version + 1) throw new PersistenceMigrationError(`${input.format} migration ${version} must produce version ${version + 1}, received ${nextVersion}.`);
    version = nextVersion;
  }
  try {
    return { value: input.schema.parse(value), migratedFrom: originalVersion === version ? undefined : originalVersion, migratedTo: version };
  } catch (error) {
    throw new PersistenceMigrationError(`${input.format} version ${version} is invalid after migration: ${(error as Error).message}`);
  }
}

async function exists(filePath: string) {
  try { await access(filePath, constants.F_OK); return true; } catch { return false; }
}

export async function persistMigratedJson<T>(filePath: string, raw: unknown, result: MigrationReadResult<T>) {
  if (result.migratedFrom === undefined) return undefined;
  const backupPath = `${filePath}.v${result.migratedFrom}.bak`;
  if (!await exists(backupPath)) await copyFile(filePath, backupPath);
  await writeJsonAtomic(filePath, result.value);
  return backupPath;
}
