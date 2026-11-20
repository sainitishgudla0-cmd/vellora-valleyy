/**
 * A minimal in-process SMTP server for tests (M11 P3-T1): speaks enough RFC 5321 for nodemailer over plaintext on a
 * loopback port (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, RSET, QUIT), records every accepted message, and can be told to
 * refuse recipients or drop the connection. No TLS: the app allows plaintext SMTP only to loopback in development/test.
 */
import net from "node:net";

export interface CapturedMail {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

export class FakeSmtp {
  messages: CapturedMail[] = [];
  /** next N RCPT commands answer 550 (permanent) */
  rejectRecipients = 0;
  /** next N connections are closed right after the greeting (temporary outage) */
  dropConnections = 0;
  private server = net.createServer((s) => this.session(s));
  port = 0;

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  url(user = "smtp-user", pass = "smtp-pass") {
    return `smtp://${user}:${pass}@127.0.0.1:${this.port}?tls=off`;
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private session(s: net.Socket) {
    const write = (l: string) => s.write(`${l}\r\n`);
    if (this.dropConnections > 0) {
      this.dropConnections--;
      write("421 service not available");
      s.end();
      return;
    }
    let buf = "";
    let inData = false;
    let authStep: null | "login-user" | "login-pass" = null;
    let mail: CapturedMail = { from: "", to: [], data: "", auth: null };
    write("220 fake-smtp ready");
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          mail.data = buf.slice(0, end).replace(/^\.\./gm, ".");
          buf = buf.slice(end + 5);
          inData = false;
          this.messages.push(mail);
          mail = { from: "", to: [], data: "", auth: mail.auth };
          write("250 2.0.0 queued");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i === -1) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (authStep === "login-user") {
          mail.auth = Buffer.from(line, "base64").toString();
          authStep = "login-pass";
          write("334 UGFzc3dvcmQ6");
          continue;
        }
        if (authStep === "login-pass") {
          authStep = null;
          write("235 2.7.0 authenticated");
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") write("250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME");
        else if (cmd === "AUTH") {
          const [, mech, arg] = line.split(" ");
          if (mech.toUpperCase() === "PLAIN") {
            mail.auth = Buffer.from(arg ?? "", "base64").toString().split("\u0000")[1] ?? null;
            write("235 2.7.0 authenticated");
          } else {
            authStep = "login-user";
            write("334 VXNlcm5hbWU6");
          }
        } else if (cmd === "MAIL") {
          mail.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          write("250 OK");
        } else if (cmd === "RCPT") {
          if (this.rejectRecipients > 0) {
            this.rejectRecipients--;
            write("550 5.1.1 mailbox unavailable");
          } else {
            mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
            write("250 OK");
          }
        } else if (cmd === "DATA") {
          inData = true;
          write("354 end with .");
        } else if (cmd === "RSET") {
          mail = { from: "", to: [], data: "", auth: mail.auth };
          write("250 OK");
        } else if (cmd === "QUIT") {
          write("221 bye");
          s.end();
        } else write("250 OK");
      }
    });
    s.on("error", () => {});
  }
}

/** The value of a header in a captured message (unfolded). */
export function header(data: string, name: string): string | null {
  const head = data.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head);
  return m ? m[1].trim() : null;
}
