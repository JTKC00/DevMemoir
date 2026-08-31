#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repositoryRoot = resolve(process.cwd());

const REQUIRED_FILES = ["README.md", "SECURITY.md", "CONTRIBUTING.md", ".env.example"];
const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".codex",
  ".git",
  ".next",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "docker-data",
  "node_modules",
]);
const REQUIRED_GITIGNORE_ENTRIES = [
  "node_modules/",
  ".pnpm-store/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  "docker-data/",
];

const HIGH_RISK_PATTERNS = [
  { id: "private_key_material", expression: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/ },
  { id: "github_token", expression: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { id: "provider_api_key", expression: /(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}/ },
  { id: "aws_access_key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "bearer_token", expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
];

const PRIVACY_CANARIES = [
  "PRIVATE_" + "REPOSITORY_NAME",
  "PRIVATE_" + "COMMIT_MESSAGE",
  "PRIVATE_" + "PR_TITLE",
  "PRIVATE_" + "WEBHOOK_PAYLOAD",
  "PRIVATE_" + "TOKEN",
  "PRIVATE_" + "SECRET",
];

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function currentTreeFiles(directory = repositoryRoot, relativeDirectory = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...currentTreeFiles(absolutePath, relativePath));
      continue;
    }

    // Local environment files are checked separately and never enter a public
    // content scan. Keep the safe template visible to the checks.
    if (entry.name === ".env" || (entry.name.startsWith(".env.") && entry.name !== ".env.example")) continue;
    if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
  }
  return files;
}

function readText(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function isSyntheticFixture(path) {
  const normalized = path.replaceAll("\\", "/");
  return /\.test\.[^/]+$/i.test(normalized) || normalized.startsWith("docs/");
}

function forbiddenTrackedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === ".env" || (normalized.startsWith(".env.") && normalized !== ".env.example")) return "environment_file";
  if (/\.(?:pem|key|p12|pfx|jks|kdbx)$/i.test(normalized)) return "private_key_file";
  if (/(?:^|\/)(?:coverage|logs|screenshots|debug)(?:\/|$)/i.test(normalized)) return "generated_or_debug_directory";
  if (/(?:\.log|\.trace|\.har|\.dump|\.sql\.gz|\.sqlite3?|\.db)$/i.test(normalized)) return "generated_or_runtime_file";
  return undefined;
}

function likelyPlaceholder(value) {
  return /(?:replace(?:-with)?-me|replace-with-[\w-]+|placeholder|dummy|fake|unused|test|example|<[^>]+>)/i.test(value)
    || /(?:localhost|127\.0\.0\.1|::1)/i.test(value);
}

function findSensitiveContent(path, content) {
  const findings = [];
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (!pattern.expression.test(content)) continue;
    if (pattern.id === "private_key_material" && /replace-me|replace-with|placeholder|example|dummy/i.test(content)) continue;
    findings.push(pattern.id);
  }

  for (const match of content.matchAll(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi)) {
    const value = match[0];
    const hasCredentials = value.includes("@");
    if (hasCredentials && !likelyPlaceholder(value)) findings.push("credential_bearing_database_url");
  }

  if (!isSyntheticFixture(path) && PRIVACY_CANARIES.some((canary) => content.includes(canary))) {
    findings.push("privacy_canary_in_non_fixture");
  }

  return [...new Set(findings)];
}

function checkEnvExample(content) {
  const findings = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) {
      findings.push("malformed_env_example_line");
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!value) continue;
    if (/https?:\/\//i.test(value) && !/(?:localhost|127\.0\.0\.1|::1|replace-me|replace-with|example\.com|<[^>]+>)/i.test(value)) {
      findings.push(`non_local_example_url:${name}`);
      continue;
    }
    if (/(?:SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL|ORIGIN|OWNER_GITHUB_USER_ID)/i.test(name) && !likelyPlaceholder(value)) {
      findings.push(`non_placeholder_example_value:${name}`);
    }
  }
  return [...new Set(findings)];
}

function checkGitignore(content) {
  const entries = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !entries.has(entry));
}

export function runCurrentTreeCheck() {
  const findings = [];
  const files = [...new Set([...trackedFiles(), ...currentTreeFiles()])];
  for (const required of REQUIRED_FILES) {
    if (!existsSync(resolve(repositoryRoot, required))) findings.push({ kind: "missing_required_file", path: required });
  }

  for (const path of files) {
    const pathFinding = forbiddenTrackedPath(path);
    if (pathFinding) findings.push({ kind: pathFinding, path });
    let content;
    try {
      content = readText(path);
    } catch {
      findings.push({ kind: "unreadable_tracked_file", path });
      continue;
    }
    for (const pattern of findSensitiveContent(path, content)) findings.push({ kind: pattern, path });
    if (path === ".env.example") {
      for (const pattern of checkEnvExample(content)) findings.push({ kind: pattern, path });
    }
  }

  const missingIgnoreEntries = checkGitignore(readText(".gitignore"));
  for (const entry of missingIgnoreEntries) findings.push({ kind: "missing_gitignore_entry", path: entry });

  const trackedEnvExample = files.includes(".env.example");
  if (!trackedEnvExample) findings.push({ kind: "env_example_not_tracked", path: ".env.example" });
  if (files.includes(".env")) findings.push({ kind: "env_file_tracked", path: ".env" });

  return { filesScanned: files.length, findings };
}

export function runSelfTests() {
  assert.equal(forbiddenTrackedPath(".env"), "environment_file");
  assert.equal(forbiddenTrackedPath(".env.example"), undefined);
  assert.equal(forbiddenTrackedPath("secrets/app.pem"), "private_key_file");
  assert(findSensitiveContent("synthetic.txt", `token=ghp_${"a".repeat(36)}`).includes("github_token"));
  const privateKeyMarker = ["-----BEGIN", " PRIVATE KEY-----"].join("");
  assert(findSensitiveContent("synthetic.txt", `${privateKeyMarker}\n${"a".repeat(32)}`).includes("private_key_material"));
  assert(findSensitiveContent("synthetic.txt", "token=replace-me").length === 0);
  assert(checkEnvExample("SECRET=replace-me\nAPI_ORIGIN=http://localhost:4000\n").length === 0);
  return true;
}

function main(args) {
  if (args.includes("--self-test")) {
    runSelfTests();
    console.log("PASS: public-readiness self-tests");
    return;
  }
  const result = runCurrentTreeCheck();
  console.log("Current-tree check only. Full Git history must also be scanned.");
  console.log(`Public-tree files scanned: ${result.filesScanned}`);
  if (result.findings.length > 0) {
    for (const finding of result.findings) console.error(`FAIL: ${finding.kind} (${finding.path})`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: no forbidden public-tree paths, high-risk values, or non-placeholder example configuration found.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2));
