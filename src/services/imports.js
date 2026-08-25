import { createHash, randomUUID } from "node:crypto";
import { audit, rowToObject, rowsToObjects } from "../db.js";
import { matchingRule } from "./rules.js";

export const DEFAULT_MAPPING = Object.freeze({
  date: "Date",
  description: "Description",
  amount: "Amount",
  debit: "",
  credit: "",
  notes: "",
  dateFormat: "auto",
  amountSign: "as-is"
});

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text ?? "").replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  return rows;
}

export function csvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV must include a header and at least one data row");
  const headers = rows[0].map((header) => header.trim());
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique");
  return {
    headers,
    records: rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])))
  };
}

function parseDate(value) {
  const input = String(value ?? "").trim();
  let match;
  if ((match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if ((match = input.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/))) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return validDate(year, Number(match[1]), Number(match[2]));
  }
  return null;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseMoney(value) {
  const input = String(value ?? "").trim();
  if (!input) return null;
  const negative = /^\(.*\)$/.test(input) || /^-/.test(input);
  const cleaned = input.replace(/[()$€£,\s+\-]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

function normalizeRecord(record, mapping) {
  const postedDate = parseDate(record[mapping.date]);
  const description = String(record[mapping.description] ?? "").trim();
  let amountMinor = null;
  if (mapping.amount) {
    amountMinor = parseMoney(record[mapping.amount]);
  } else {
    const debit = parseMoney(record[mapping.debit]);
    const credit = parseMoney(record[mapping.credit]);
    if (debit !== null || credit !== null) amountMinor = (credit ?? 0) - Math.abs(debit ?? 0);
  }
  if (amountMinor !== null && mapping.amountSign === "flip") amountMinor *= -1;

  const errors = [];
  if (!postedDate) errors.push("Unparseable date");
  if (!description) errors.push("Blank description");
  if (amountMinor === null) errors.push("Unparseable amount");
  return { postedDate, description, amountMinor, errors };
}

function fingerprint(accountId, postedDate, amountMinor, description) {
  return createHash("sha256")
    .update([accountId, postedDate, amountMinor, description.trim().toUpperCase()].join("|"))
    .digest("hex");
}

function fileHash(csv) {
  return createHash("sha256").update(csv).digest("hex");
}

export function stageImport(db, payload) {
  const files = payload.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("At least one CSV file is required");
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO import_runs (id, status, file_count, created_at) VALUES (?, 'staged', ?, ?)")
    .run(runId, files.length, now);

  let rowsRead = 0;
  let newCount = 0;
  let duplicateCount = 0;
  let exceptionCount = 0;
  const preview = [];

  const transaction = db.transaction(() => {
    for (const file of files) {
      const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(file.accountId);
      if (!account) throw new Error(`Unknown account for ${file.name}`);
      const mapping = { ...DEFAULT_MAPPING, ...(file.mapping ?? {}) };
      const { headers, records } = csvObjects(file.csv);
      for (const required of [mapping.date, mapping.description]) {
        if (!headers.includes(required)) throw new Error(`${file.name}: missing mapped column "${required}"`);
      }
      if (mapping.amount && !headers.includes(mapping.amount)) throw new Error(`${file.name}: missing mapped amount column`);

      const fileId = randomUUID();
      db.prepare(
        "INSERT INTO import_files (id, import_run_id, account_id, file_name, content_sha256, mapping_json, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(fileId, runId, file.accountId, file.name, fileHash(file.csv), JSON.stringify(mapping), records.length, now);

      for (let index = 0; index < records.length; index += 1) {
        const raw = records[index];
        const normalized = normalizeRecord(raw, mapping);
        const recordId = randomUUID();
        let disposition = "new";
        let recordFingerprint = null;
        if (normalized.errors.length) {
          disposition = "exception";
          exceptionCount += 1;
        } else {
          recordFingerprint = fingerprint(file.accountId, normalized.postedDate, normalized.amountMinor, normalized.description);
          const existing = db.prepare("SELECT id FROM transactions WHERE fingerprint = ?").get(recordFingerprint);
          const staged = db.prepare(
            "SELECT id FROM raw_import_records WHERE fingerprint = ? AND disposition IN ('new', 'duplicate')"
          ).get(recordFingerprint);
          if (existing || staged) {
            disposition = "duplicate";
            duplicateCount += 1;
          } else {
            newCount += 1;
          }
        }
        db.prepare(
          `INSERT INTO raw_import_records
           (id, import_run_id, import_file_id, account_id, row_number, raw_json, posted_date, description, amount_minor, fingerprint, disposition, exception, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          recordId, runId, fileId, file.accountId, index + 2, JSON.stringify(raw),
          normalized.postedDate, normalized.description, normalized.amountMinor, recordFingerprint,
          disposition, normalized.errors.join("; ") || null, now
        );
        rowsRead += 1;
        if (preview.length < 12) {
          preview.push({ id: recordId, fileName: file.name, rowNumber: index + 2, ...normalized, disposition });
        }
      }
    }
    db.prepare(
      "UPDATE import_runs SET rows_read = ?, new_count = ?, duplicate_count = ?, exception_count = ? WHERE id = ?"
    ).run(rowsRead, newCount, duplicateCount, exceptionCount, runId);
  });
  transaction();
  audit(db, "import_run", runId, "staged", { rowsRead, newCount, duplicateCount, exceptionCount });
  return { id: runId, status: "staged", rowsRead, newCount, duplicateCount, exceptionCount, preview };
}

function findOrCreateMerchant(db, name) {
  const cleaned = name.trim().replace(/\s+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  const existing = db.prepare("SELECT id, name FROM merchants WHERE name = ? COLLATE NOCASE").get(cleaned);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare("INSERT INTO merchants (id, name, created_at) VALUES (?, ?, ?)").run(id, cleaned, new Date().toISOString());
  return { id, name: cleaned };
}

export function commitImport(db, runId, { allowExceptions = false } = {}) {
  const run = db.prepare("SELECT * FROM import_runs WHERE id = ?").get(runId);
  if (!run) throw Object.assign(new Error("Import run not found"), { statusCode: 404 });
  if (run.status !== "staged") throw new Error("Only staged imports can be committed");
  if (run.exception_count && !allowExceptions) {
    throw Object.assign(new Error("Resolve exceptions or explicitly hold them for later review"), { statusCode: 409 });
  }
  const records = db.prepare(
    "SELECT * FROM raw_import_records WHERE import_run_id = ? AND disposition = 'new' ORDER BY row_number"
  ).all(runId);
  const now = new Date().toISOString();
  let committed = 0;

  const transaction = db.transaction(() => {
    for (const record of records) {
      if (db.prepare("SELECT id FROM transactions WHERE fingerprint = ?").get(record.fingerprint)) {
        db.prepare("UPDATE raw_import_records SET disposition = 'duplicate' WHERE id = ?").run(record.id);
        continue;
      }
      const rule = matchingRule(db, record.account_id, record.description);
      const merchant = findOrCreateMerchant(db, rule?.merchantName || record.description);
      const transactionId = randomUUID();
      db.prepare(
        `INSERT INTO transactions
         (id, account_id, raw_import_record_id, posted_date, amount_minor, original_description, merchant_id, category_id, is_transfer, excluded, fingerprint, classification_source, classification_rule_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        transactionId, record.account_id, record.id, record.posted_date, record.amount_minor,
        record.description, merchant.id, rule?.categoryId ?? null, rule?.markTransfer ? 1 : 0,
        rule?.markTransfer ? 1 : 0, record.fingerprint, rule ? "rule" : null, rule?.id ?? null, now, now
      );
      db.prepare("UPDATE raw_import_records SET disposition = 'committed', normalized_transaction_id = ? WHERE id = ?")
        .run(transactionId, record.id);
      if (rule) {
        db.prepare("UPDATE classification_rules SET match_count = match_count + 1, last_hit_at = ? WHERE id = ?")
          .run(now, rule.id);
      }
      audit(db, "transaction", transactionId, "imported", { importRunId: runId, ruleId: rule?.id ?? null });
      committed += 1;
    }
    db.prepare("UPDATE import_runs SET status = 'committed', committed_at = ? WHERE id = ?").run(now, runId);
  });
  transaction();
  audit(db, "import_run", runId, "committed", { committed });
  return { id: runId, status: "committed", committed, duplicatesSkipped: run.duplicate_count, heldForReview: run.exception_count };
}

export function resolveImportRecord(db, recordId, changes) {
  const record = db.prepare("SELECT * FROM raw_import_records WHERE id = ?").get(recordId);
  if (!record) throw Object.assign(new Error("Import record not found"), { statusCode: 404 });
  const postedDate = changes.postedDate ? parseDate(changes.postedDate) : record.posted_date;
  const description = changes.description?.trim() || record.description;
  const amountMinor = Number.isSafeInteger(changes.amountMinor) ? changes.amountMinor : record.amount_minor;
  if (!postedDate || !description || !Number.isSafeInteger(amountMinor)) throw new Error("A valid date, description, and amount are required");
  const recordFingerprint = fingerprint(record.account_id, postedDate, amountMinor, description);
  const duplicate = db.prepare("SELECT id FROM transactions WHERE fingerprint = ?").get(recordFingerprint);
  db.prepare(
    "UPDATE raw_import_records SET posted_date = ?, description = ?, amount_minor = ?, fingerprint = ?, disposition = ?, exception = NULL WHERE id = ?"
  ).run(postedDate, description, amountMinor, recordFingerprint, duplicate ? "duplicate" : "new", recordId);
  recalculateRun(db, record.import_run_id);
  audit(db, "raw_import_record", recordId, "resolved", changes);
  return rowToObject(db.prepare("SELECT * FROM raw_import_records WHERE id = ?").get(recordId));
}

function recalculateRun(db, runId) {
  const counts = db.prepare(
    `SELECT COUNT(*) rows_read,
      SUM(disposition = 'new') new_count,
      SUM(disposition = 'duplicate') duplicate_count,
      SUM(disposition = 'exception') exception_count
     FROM raw_import_records WHERE import_run_id = ?`
  ).get(runId);
  db.prepare(
    "UPDATE import_runs SET rows_read = ?, new_count = ?, duplicate_count = ?, exception_count = ? WHERE id = ?"
  ).run(counts.rows_read, counts.new_count, counts.duplicate_count, counts.exception_count, runId);
}

export function importHistory(db) {
  return rowsToObjects(db.prepare(
    `SELECT r.*, GROUP_CONCAT(f.file_name, ', ') file_names
     FROM import_runs r LEFT JOIN import_files f ON f.import_run_id = r.id
     GROUP BY r.id ORDER BY r.created_at DESC`
  ).all());
}

export function importDetail(db, runId) {
  const run = rowToObject(db.prepare("SELECT * FROM import_runs WHERE id = ?").get(runId));
  if (!run) return null;
  run.files = rowsToObjects(db.prepare("SELECT * FROM import_files WHERE import_run_id = ? ORDER BY created_at").all(runId));
  run.records = rowsToObjects(db.prepare(
    "SELECT * FROM raw_import_records WHERE import_run_id = ? ORDER BY import_file_id, row_number"
  ).all(runId));
  return run;
}
