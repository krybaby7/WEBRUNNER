import { z } from "zod";

/** `accounts` input and output, PLAN.md section 14.7. Owned by WP15, consumed by WP16. */

export const ACCOUNT_PLATFORMS = ["reddit", "x", "facebook", "instagram", "google", "amazon", "linkedin"] as const;
export const AccountPlatformSchema = z.enum(ACCOUNT_PLATFORMS);
export type AccountPlatform = z.infer<typeof AccountPlatformSchema>;

export const ACCOUNT_ACTIONS = ["list", "connect", "disconnect"] as const;
export const AccountActionSchema = z.enum(ACCOUNT_ACTIONS);
export type AccountAction = z.infer<typeof AccountActionSchema>;

export const DEFAULT_CONNECT_WAIT_S = 120;
export const MAX_CONNECT_WAIT_S = 300;

export const AccountsInputSchema = z
  .object({
    action: AccountActionSchema.describe("list: what is connected. connect: open the platform's login page in the browser and wait for you to log in. disconnect: clear that platform's cookies."),
    platform: AccountPlatformSchema.optional().describe("Required for connect and disconnect."),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONNECT_WAIT_S)
      .default(DEFAULT_CONNECT_WAIT_S)
      .describe(`connect only: how long to wait for the login to complete (0 to ${MAX_CONNECT_WAIT_S}, default ${DEFAULT_CONNECT_WAIT_S}).`),
  })
  .refine((i) => i.action === "list" || i.platform !== undefined, { error: "platform is required for this action", path: ["platform"] });
export type AccountsInput = z.input<typeof AccountsInputSchema>;

export const AccountStatusSchema = z.object({
  platform: AccountPlatformSchema,
  connected: z.boolean(),
  domains: z.array(z.string().min(1)),
  /** Tools (and platforms within them) that read through this login. */
  used_by: z.array(z.string().min(1)),
  checked_at: z.string(),
  expires_at: z.string().optional(),
});
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountsListOutputSchema = z.object({
  action: z.literal("list"),
  mode: z.enum(["persistent", "cdp"]),
  profile_dir: z.string().optional(),
  accounts: z.array(AccountStatusSchema),
  caveats: z.array(z.string()),
});

export const AccountsConnectOutputSchema = z.object({
  action: z.literal("connect"),
  platform: AccountPlatformSchema,
  status: z.enum(["connected", "pending", "already_connected"]),
  login_url: z.string().url(),
  waited_s: z.number().nonnegative(),
  instructions: z.string().min(1),
  caveats: z.array(z.string()),
});

export const AccountsDisconnectOutputSchema = z.object({
  action: z.literal("disconnect"),
  platform: AccountPlatformSchema,
  status: z.enum(["disconnected", "not_connected"]),
  cookies_cleared: z.number().int().nonnegative(),
  caveats: z.array(z.string()),
});

export const AccountsOutputSchema = z.discriminatedUnion("action", [
  AccountsListOutputSchema,
  AccountsConnectOutputSchema,
  AccountsDisconnectOutputSchema,
]);
export type AccountsOutput = z.infer<typeof AccountsOutputSchema>;
