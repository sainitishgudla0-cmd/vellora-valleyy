import { assertServerIsDisposable } from "../../scripts/lib/safety";

/** Browser tests write orders and accounts: refuse unless the server itself proves its database is disposable (handshake route). */
export default async function globalSetup() {
  const base = process.env.E2E_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3100";
  await assertServerIsDisposable(base);
}
