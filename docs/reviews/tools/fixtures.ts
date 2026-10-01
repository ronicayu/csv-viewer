// THROWAWAY (UX review): realistic "wide export with long text" fixture.
// 25 columns. Five prose columns hold 2–8 KB each; one column holds a
// minified JSON blob. Deterministic (seeded) so screenshots are stable.

import { toCsvText } from "../stress/stressHelpers";

let seed = 42;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(a: T[]): T {
  return a[Math.floor(rand() * a.length)];
}

const SENTENCES = [
  "Customer reported that the nightly export stopped including archived invoices after the March migration.",
  "We walked through the reconciliation steps together on a call and confirmed the totals match the ledger.",
  "Escalated to tier two because the issue reproduces only for accounts with more than one billing contact.",
  "The account owner asked for a written summary they can forward to their finance team before quarter close.",
  "Follow-up scheduled for next Tuesday; they want to understand why the CSV header order changed.",
  "Note: the customer's IT policy blocks third-party OAuth apps, so the connector must use an API key instead.",
  "Discussed renewal terms. They are price sensitive but value the audit log feature highly.",
  "Workaround applied: re-ran the sync with the legacy flag enabled, which restored the missing rows.",
  "They mentioned evaluating a competitor mainly for its spreadsheet-style filtering of large tables.",
  "Internal: do not offer the extended trial again; this account already received two extensions last year.",
  "Root cause appears to be a timezone mismatch between the warehouse (UTC) and the reporting layer (local).",
  "Shared the knowledge-base article on custom delimiters and confirmed semicolon exports now open correctly.",
];

function prose(minChars: number, maxChars: number, paragraphs = true): string {
  const target = Math.floor(minChars + rand() * (maxChars - minChars));
  let out = "";
  let sinceBreak = 0;
  while (out.length < target) {
    out += (out ? " " : "") + pick(SENTENCES);
    sinceBreak++;
    if (paragraphs && sinceBreak >= 4 && rand() < 0.4) {
      out += "\n\n";
      sinceBreak = 0;
    }
  }
  return out.replace(/ \n/g, "\n");
}

function jsonBlob(i: number): string {
  const obj = {
    id: `cus_${(100000 + i * 7919).toString(36)}`,
    plan: { tier: pick(["starter", "team", "enterprise"]), seats: 5 + (i % 40), billing: pick(["monthly", "annual"]) },
    flags: { sso: rand() < 0.5, auditLog: rand() < 0.5, legacySync: rand() < 0.2, betaFilters: rand() < 0.3 },
    integrations: Array.from({ length: 3 + (i % 4) }, (_, k) => ({
      name: pick(["salesforce", "hubspot", "zendesk", "slack", "snowflake", "bigquery"]),
      status: pick(["connected", "error", "paused"]),
      lastSyncAt: `2026-0${1 + (k % 9)}-1${k}T0${k}:15:00Z`,
    })),
    addresses: [
      { type: "billing", line1: `${100 + i} Market Street`, city: pick(["San Francisco", "Berlin", "London", "Singapore"]), postcode: `9${i}10${i % 10}` },
      { type: "shipping", line1: `${200 + i} Harbour Road`, city: pick(["Sydney", "Toronto", "Austin"]), postcode: `7${i}20${i % 10}` },
    ],
    tags: ["priority", "renewal-q4", "migrated-2026"],
  };
  return JSON.stringify(obj);
}

export const WIDE_HEADERS = [
  "id",
  "customer_name",
  "status",
  "description", // prose (visible in table by default — within first 8)
  "owner",
  "region",
  "notes", // prose (visible in table by default)
  "created_at",
  "plan",
  "country",
  "priority",
  "tags",
  "score",
  "last_contacted",
  "source",
  "external_ref",
  "support_history", // prose
  "call_transcript", // prose
  "internal_comments", // prose
  "metadata_json", // JSON blob
  "mrr_usd",
  "seats",
  "renewal_date",
  "account_manager_email",
  "is_active",
];

export function wideFixtureRows(rowCount: number, opts: { pathologicalRef?: boolean; hugeTranscriptRow?: number } = {}): string[][] {
  seed = 42;
  const rows: string[][] = [];
  for (let i = 0; i < rowCount; i++) {
    const name = `${pick(["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Vandelay", "Stark", "Wayne"])} ${pick(["Logistics", "Health", "Analytics", "Foods", "Robotics", "Media"])} ${pick(["GmbH", "Inc.", "Ltd", "Pty Ltd", "LLC"])}`;
    rows.push([
      String(1000 + i),
      name,
      pick(["active", "churned", "trial", "paused"]),
      prose(2000, 3500, false),
      pick(["Priya Raman", "Tom Becker", "Ana Souza", "Kenji Watanabe", "Lena Fischer"]),
      pick(["NA", "EMEA", "APAC", "LATAM"]),
      prose(2000, 4000, true),
      `2025-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      pick(["starter", "team", "enterprise"]),
      pick(["US", "DE", "GB", "SG", "BR", "AU", "CA"]),
      pick(["P1", "P2", "P3"]),
      pick(["renewal;upsell", "at-risk", "", "beta;sso", "migration"]),
      (rand() * 100).toFixed(1),
      `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`,
      pick(["inbound", "partner", "outbound", "event"]),
      opts.pathologicalRef && i === 0 ? "a".repeat(40) + "b" : `REF-${String(10000 + i * 13)}`,
      prose(3000, 6000, true),
      opts.hugeTranscriptRow === i ? prose(14000, 14500, true) : prose(5000, 8000, true),
      prose(2000, 3000, true),
      jsonBlob(i),
      String(Math.round(rand() * 20000) / 100),
      String(5 + (i % 40)),
      `2027-0${1 + (i % 9)}-15`,
      `am${i % 7}@example.com`,
      rand() < 0.8 ? "true" : "false",
    ]);
  }
  return rows;
}

export function wideCsv(rowCount: number, opts: { pathologicalRef?: boolean; hugeTranscriptRow?: number } = {}): string {
  return toCsvText(WIDE_HEADERS, wideFixtureRows(rowCount, opts));
}
