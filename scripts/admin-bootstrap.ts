/**
 * Operator tool (M4-T4, ADR 0012): create the FIRST owner account, or reset an owner's password (recovery).
 *   npm run admin:bootstrap -- --email you@example.com --name "Your Name"
 *   npm run admin:bootstrap -- --reset --email you@example.com
 * Guarded by scripts/db-guard.ts (production needs the explicit confirmation). The password comes from the
 * ADMIN_BOOTSTRAP_PASSWORD environment variable or a hidden prompt; it is never an argument, never printed, never logged.
 * Creating refuses if any owner exists (further accounts are made by an owner through the admin API).
 */
import readline from "node:readline";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = (rl as unknown as { _writeToOutput: (s: string) => void });
    w._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) throw new Error("Set ADMIN_BOOTSTRAP_PASSWORD or run in an interactive terminal.");
  const a = await promptHidden("New password: ");
  const b = await promptHidden("Repeat password: ");
  if (a !== b) throw new Error("Passwords do not match.");
  return a;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  if (!email) throw new Error("--email is required");
  const reset = process.argv.includes("--reset");
  const { db } = await import("../src/lib/db");
  const { createUser, resetPassword } = await import("../src/lib/auth/users");
  const { writeAudit } = await import("../src/lib/auth/audit");
  const who = { userId: null, label: "bootstrap-script", role: "owner" as const };

  if (reset) {
    const user = await db.adminUser.findUnique({ where: { email } });
    if (!user || user.role !== "owner") throw new Error("No owner account with that email.");
    const r = await resetPassword(user.id, await readPassword());
    if (!r.ok) throw new Error(r.message);
    await db.adminUser.update({ where: { id: user.id }, data: { active: true } });
    await writeAudit({ action: "owner.password_reset", outcome: "success", admin: who, targetType: "admin_user", targetId: user.id, details: { sessionsRevoked: r.sessionsRevoked } });
    console.log(`[admin] Password reset for ${email}; ${r.sessionsRevoked} session(s) ended; account unlocked and active.`);
    return;
  }

  if ((await db.adminUser.count({ where: { role: "owner" } })) > 0) throw new Error("An owner already exists. Create further accounts through the admin API, or use --reset to recover an owner.");
  const name = arg("name")?.trim();
  if (!name) throw new Error("--name is required");
  const r = await createUser({ email, name, role: "owner", password: await readPassword() });
  if (!r.ok) throw new Error(r.message);
  await writeAudit({ action: "owner.bootstrap", outcome: "success", admin: who, targetType: "admin_user", targetId: r.user.id });
  console.log(`[admin] Owner ${email} created. Sign in with POST /api/admin/login { email, password }.`);
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[admin] ${e instanceof Error ? e.message : "failed"}`);
    process.exit(1);
  });
