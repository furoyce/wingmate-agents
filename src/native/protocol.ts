// Shared wire schemas. Recipes are untrusted; runtime, app provenance and device selection are dispatcher policy.
import { createHash } from "node:crypto";
import { z } from "zod";
// Include bounded helper timeout grace in cleanup; reserve a coordinator delivery and admission work too.
export const NATIVE_CLEANUP_RESERVE_MS = 40_000;
export const NATIVE_DELIVERY_RESERVE_MS = 35_000;
export const NATIVE_ADMISSION_HEADROOM_MS = 10_000;
export const NATIVE_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
// These are total wall budgets, including subprocess termination/drain grace, within the unchanged 40-second reserve.
export const NATIVE_DEVICE_CLEANUP_MS = 25_000;
export const NATIVE_LEASE_CLEANUP_MS = 5_000;

export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RequestId = z.string().regex(/^[0-9A-Za-z]{1,64}$/);
const Text = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32), "control characters forbidden");
export const NativeRecipeSchema = z
  .object({
    kind: z.literal("ios"),
    steps: z
      .array(
        z.union([
          z.object({ expectText: Text }).strict(),
          z.object({ tapText: Text }).strict(),
          z.object({ screenshot: z.literal(true) }).strict(),
        ]),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine((r) => r.steps.some((s) => "expectText" in s), "at least one native text assertion required");
export type NativeRecipe = z.infer<typeof NativeRecipeSchema>;

// This is owner-controlled configuration, never an agent recipe. No build command is supported: repo build scripts cannot run
// on the credentialed host. A trusted isolated producer must put a content-bound app and receipt in the protected artifact store.
export const NativePolicySchema = z
  .object({
    runtime: z.string().regex(/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9]+(?:-[0-9]+){1,2}$/),
    deviceType: z.string().regex(/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[A-Za-z0-9-]+$/),
    bundleId: z.string().regex(/^[A-Za-z0-9]+(?:\.[A-Za-z0-9-]+)+$/),
    producer: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    isolationHash: Digest,
    executionIsolationHash: Digest,
    launchArgs: z.array(z.string().max(500)).max(16).default([]),
    testEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(1000)).default({}),
    timeoutMs: z.number().int().min(10_000).max(100_000).default(90_000),
  })
  .strict();
export type NativePolicy = z.infer<typeof NativePolicySchema>;
export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const policyHash = (policy: NativePolicy): string =>
  hash(
    JSON.stringify({
      ...policy,
      testEnv: Object.fromEntries(Object.entries(policy.testEnv).sort(([a], [b]) => a.localeCompare(b))),
    }),
  );
export const recipeHash = (recipe: NativeRecipe): string => hash(JSON.stringify(recipe));

export const ArtifactReceiptSchema = z
  .object({
    version: z.literal(1),
    provenance: z.literal("dispatcher-isolated-build"),
    producer: z.string(),
    isolationHash: Digest,
    sourceHead: Sha,
    policyHash: Digest,
    bundleId: z.string(),
    appHash: Digest,
    builtAt: z.string().datetime(),
  })
  .strict();

// An opaque, non-secret adapter reference to one isolated runtime lease. It is not an endpoint, path or attestation shortcut.
// Only the trusted adapter issues/resolves it; profile changes must not redirect recovery to a different runtime.
export const NativeRuntimeBindingSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    profileHash: Digest,
  })
  .strict()
  .readonly();
export type NativeRuntimeBinding = z.infer<typeof NativeRuntimeBindingSchema>;
export const NativeRuntimeRequestSchema = z
  .object({ requestId: RequestId, worktreeId: z.string().min(1).max(4096), profileHash: Digest })
  .strict()
  .readonly();
export type NativeRuntimeRequest = z.infer<typeof NativeRuntimeRequestSchema>;
// A read-only lookup must distinguish verified absence from an unavailable broker/lease registry.
export const NativeRuntimeLookupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent"), request: NativeRuntimeRequestSchema }).strict(),
  z
    .object({
      status: z.literal("bound"),
      request: NativeRuntimeRequestSchema,
      binding: NativeRuntimeBindingSchema,
    })
    .strict(),
]);
export type NativeRuntimeLookup = z.infer<typeof NativeRuntimeLookupSchema>;
export const sameRuntimeBinding = (a: NativeRuntimeBinding, b: NativeRuntimeBinding): boolean =>
  a.version === b.version && a.id === b.id && a.profileHash === b.profileHash;
export const runtimeBindingHash = (binding: NativeRuntimeBinding): string =>
  hash(JSON.stringify([binding.version, binding.id, binding.profileHash]));

export const NativeJobSchema = z.object({
  id: RequestId,
  issue: z.string(),
  cycle: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  worktreeId: z.string(),
  headSha: Sha,
  policyHash: Digest,
  executionIsolationHash: Digest,
  runtimeBinding: NativeRuntimeBindingSchema.nullable().default(null),
  runtimeAcquireUncertain: z.boolean().default(false),
  runtimeReleased: z.boolean().default(true),
  deviceCleanupComplete: z.boolean().default(false),
  recipeHash: Digest,
  requestedAt: z.string().datetime(),
  status: z.enum(["running", "succeeded", "failed", "unverifiable"]),
  udid: z.string().uuid().nullable(),
  createUncertain: z.boolean(),
  cleanupComplete: z.boolean(),
  receiptHash: Digest.nullable(),
  evidencePath: z.string(),
  notified: z.boolean(),
});
export type NativeJob = z.infer<typeof NativeJobSchema>;
/** Runtime routing belongs only in protected dispatcher state, never the advisory agent mirror. */
export const nativeJobViews = (jobs: NativeJob[]) => jobs.map(({ runtimeBinding: _binding, ...job }) => job);

export const NativeReceiptSchema = z
  .object({
    version: z.literal(1),
    requestId: RequestId,
    issue: z.string(),
    cycle: z.number().int().positive(),
    attempt: z.number().int().nonnegative(),
    worktreeId: z.string(),
    headSha: Sha,
    policyHash: Digest,
    recipeHash: Digest,
    runtimeBindingHash: Digest.nullable().default(null),
    appHash: Digest.nullable(),
    appPid: z.number().int().positive().nullable(),
    udid: z.string().uuid().nullable(),
    verdict: z.enum(["PASS", "FAIL"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    assertions: z.number().int().nonnegative(),
    error: z.string().nullable(),
    cleanupComplete: z.boolean(),
    artifacts: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/), hash: Digest }).strict()),
  })
  .strict();
export type NativeReceipt = z.infer<typeof NativeReceiptSchema>;
