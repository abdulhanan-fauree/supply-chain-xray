import { z } from "zod";

/**
 * Connection details are read from the environment and never committed.
 * See .env.example for the template.
 *
 * Validation returns a result object rather than throwing, so a misconfigured
 * deployment renders an explanatory screen instead of a 500 with a stack trace.
 */

const BOLT_SCHEMES = [
  "bolt://",
  "bolt+s://",
  "bolt+ssc://",
  "neo4j://",
  "neo4j+s://",
  "neo4j+ssc://",
];

const envSchema = z.object({
  COGNODB_URI: z
    .string()
    .min(1, "COGNODB_URI is required")
    .refine(
      (uri) => BOLT_SCHEMES.some((scheme) => uri.startsWith(scheme)),
      `COGNODB_URI must start with one of: ${BOLT_SCHEMES.join(", ")}`,
    ),
  COGNODB_USER: z.string().min(1).default("cognodb"),
  COGNODB_PASSWORD: z.string().min(1, "COGNODB_PASSWORD is required"),
  COGNODB_DATABASE: z.string().min(1).default("neo4j"),
});

export type Env = z.infer<typeof envSchema>;

export type EnvResult =
  | { ok: true; env: Env }
  | { ok: false; problems: string[] };

let cached: EnvResult | null = null;

export function readEnv(): EnvResult {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    COGNODB_URI: process.env.COGNODB_URI,
    COGNODB_USER: process.env.COGNODB_USER,
    COGNODB_PASSWORD: process.env.COGNODB_PASSWORD,
    COGNODB_DATABASE: process.env.COGNODB_DATABASE,
  });

  cached = parsed.success
    ? { ok: true, env: parsed.data }
    : {
        ok: false,
        problems: parsed.error.issues.map((issue) =>
          issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
        ),
      };

  return cached;
}

/** Throwing variant, for scripts where failing fast is the right behaviour. */
export function requireEnv(): Env {
  const result = readEnv();
  if (!result.ok) {
    throw new Error(
      `Invalid CognoDB configuration:\n  - ${result.problems.join("\n  - ")}\n\n` +
        `Copy .env.example to .env.local and fill in your instance details.`,
    );
  }
  return result.env;
}

/** Redacted form, safe to log or show in a diagnostics panel. */
export function describeConnection(env: Env): string {
  try {
    const url = new URL(env.COGNODB_URI);
    return `${url.protocol}//${url.hostname} (user: ${env.COGNODB_USER}, db: ${env.COGNODB_DATABASE})`;
  } catch {
    return `${env.COGNODB_URI} (user: ${env.COGNODB_USER})`;
  }
}
