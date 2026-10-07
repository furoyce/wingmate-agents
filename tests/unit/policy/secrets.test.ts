import { describe, expect, test } from "bun:test";
import { scanAddedLines, scanText } from "../../../src/policy/secrets";

describe("secrets", () => {
  const hits: [string, string][] = [
    ["anthropic key", "key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"],
    ["github token", "GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12"],
    ["fine-grained pat", "github_pat_11AAAAAAA0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    [
      "jwt",
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["postgres url", "postgresql://app:s3cretpass@db.example.com:5432/app"],
    [
      "supabase pooler url",
      "DATABASE_URL=postgres://postgres.abcdefgh:Sup3rS3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    ],
    [
      "neon connection string",
      "postgresql://neondb_owner:npg_AbC123xyz@ep-cool-sound-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
    ],
    ["neon api key", "NEON_API_KEY=npg_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
    ["supabase secret key", "sb_secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["slack", "xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx"],
    ["openai key", "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh"],
    ["high entropy", "token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa99887766554433221100"],
    ["high entropy base64", "SECRET_KEY = 'ZmJ4OXdhU1l0bU9QeW5kRWFMRTNHVm92U3dxbzFRS3dIU2hqSUZaNA=='"],
    ["dotenv key without spaces (R18)", "SECRET_KEY=ABCDEF0123456789ABCDEF0123456789ABCD"],
    ["dotenv secret without spaces (R18)", "API_SECRET=q7Zp3Lm9Xc2Vb8Nn4Qw6Er1Ty5Ui0Op7As"],
  ];
  for (const [name, text] of hits)
    test(`detects ${name}`, () => {
      expect(scanText(text).length).toBeGreaterThan(0);
    });
  const clean: [string, string][] = [
    ["env lookup", "const url = process.env.DATABASE_URL;"],
    ["ci placeholder", "SUPABASE_SERVICE_ROLE_KEY=ci-not-a-real-key"],
    ["sha256 line", "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["git sha in prose", "Reverted in commit 3f786850e387550fdab836ed7e6dc881de23001b after the regression."],
    ["uuid as a key id", "apiKeyId: 550e8400-e29b-41d4-a716-446655440000"],
    ["ordinary url", "see https://docs.example.com/reference/authentication?section=tokens#overview"],
    ["lorem", "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt."],
    ["identifier soup", "const authorizationHeaderName = 'X-Authorization-Header-Name-Override';"],
    ["postgres url without credentials", "postgresql://localhost:5432/app"],
    [
      "long hex hash without key context",
      "etag: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa99887766554433221100",
    ],
    [
      "gcp secret resource name",
      'secretVersion: "projects/123456789012/secrets/database-password/versions/3"',
    ],
    ["secret manager path", 'const secretPath = "/projects/my-project/secrets/db-password/versions/latest"'],
    ["keyof over a long constant", "type K = keyof typeof DEFAULT_CONFIGURATION_VALUES_MAP;"],
    ["screaming constant after a key word", "const key = DEFAULT_SIGNING_KEY_ROTATION_POLICY_V2;"],
    ["dotenv screaming constant value", "SIGNING_KEY=DEFAULT_SIGNING_KEY_ROTATION_POLICY_V2"],
    ["dotenv path value", "SECRET_PATH=projects/123456789012/secrets/database-password/versions/3"],
    ["dotenv uuid value", "API_KEY_ID=550e8400-e29b-41d4-a716-446655440000"],
  ];
  for (const [name, text] of clean)
    test(`ignores ${name}`, () => {
      expect(scanText(text)).toEqual([]);
    });
  test("findings never echo the secret beyond a six-character prefix", () => {
    const f = scanText("GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12");
    expect(f[0]?.excerpt).toBe("ghp_AB…");
    expect(JSON.stringify(f)).not.toContain("ghij12");
  });
  test("one secret yields one finding even when several detectors match it", () => {
    expect(scanText("key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ")).toEqual([
      { pattern: "anthropic", excerpt: "sk-ant…" },
    ]);
    expect(scanText("GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12")).toHaveLength(1);
    expect(
      scanText(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toEqual([{ pattern: "jwt", excerpt: "eyJhbG…" }]);
  });
  test("R18: a dotenv NAME=value (or NAME:value) line is judged with its key context; the excerpt is the value's prefix", () => {
    expect(scanText("SECRET_KEY=ABCDEF0123456789ABCDEF0123456789ABCD")).toEqual([
      { pattern: "high_entropy", excerpt: "ABCDEF…" },
    ]);
    expect(scanText("API_SECRET=q7Zp3Lm9Xc2Vb8Nn4Qw6Er1Ty5Ui0Op7As")).toEqual([
      { pattern: "high_entropy", excerpt: "q7Zp3L…" },
    ]);
    expect(scanText("API_SECRET:q7Zp3Lm9Xc2Vb8Nn4Qw6Er1Ty5Ui0Op7As")).toHaveLength(1);
    expect(
      scanAddedLines([
        { path: "ci/deploy.yml", line: "      - SECRET_KEY=ABCDEF0123456789ABCDEF0123456789ABCD" },
      ]),
    ).toMatchObject([{ path: "ci/deploy.yml", pattern: "high_entropy" }]);
  });
  test("two different secrets on separate lines are both reported", () => {
    const f = scanText("A=AKIAIOSFODNN7EXAMPLE\nB=xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx");
    expect(f.map((x) => x.pattern).sort()).toEqual(["aws", "slack"]);
  });
  test("added lines carry the path and skip examples and docs", () => {
    const f = scanAddedLines([
      { path: "api/.env.example", line: "AWS_KEY=AKIAIOSFODNN7EXAMPLE" },
      { path: "README.md", line: "GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12" },
      { path: "src/a.ts", line: "const k='AKIAIOSFODNN7EXAMPLE'" },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: "src/a.ts", pattern: "aws" });
  });
  test("a private key block in a markdown file is still reported", () => {
    expect(
      scanAddedLines([{ path: "docs/setup.md", line: "-----BEGIN OPENSSH PRIVATE KEY-----" }]),
    ).toHaveLength(1);
  });
});
