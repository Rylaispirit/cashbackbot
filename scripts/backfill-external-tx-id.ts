/**
 * Backfill Transaction.externalTxId for legacy rows after the Accesstrade
 * multi-row-order migration.
 *
 * Default is dry-run. Pass --apply to write.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

interface Candidate {
  id: string;
  orderId: string;
  externalTxId: string;
  reason: 'raw_transaction_id' | 'alibo_order_id';
}

interface BackfillRow {
  id: string;
  orderId: string;
  rawPayload: unknown;
  link: { network: string } | null;
}

interface Conflict {
  externalTxId: string;
  ids: string[];
  reason: string;
}

interface Stats {
  scannedMissing: number;
  skippedAlreadySet: number;
  skippedUnknownLegacy: number;
  skippedConflict: number;
  wouldUpdate: number;
  updated: number;
}

function parseArgs() {
  const apply = process.argv.includes('--apply');
  const dry = process.argv.includes('--dry');
  if (apply && dry) {
    throw new Error('Use either --dry or --apply, not both.');
  }
  return { apply };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function scalarToText(value: unknown): string | null {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'bigint'
  ) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function rawTransactionId(rawPayload: unknown): string | null {
  const raw = asRecord(rawPayload);
  return raw ? scalarToText(raw.transaction_id) : null;
}

function isAliboLegacy(
  rawPayload: unknown,
  linkNetwork: string | null | undefined,
): boolean {
  if (linkNetwork === 'alibo') return true;

  const raw = asRecord(rawPayload);
  const source = raw ? scalarToText(raw.source) : null;
  return (
    source === 'manual_alibo' ||
    source === 'csv_reconcile' ||
    source === 'csv_reconcile_status_update'
  );
}

function buildCandidate(row: BackfillRow): Candidate | null {
  const txId = rawTransactionId(row.rawPayload);
  if (txId) {
    return {
      id: row.id,
      orderId: row.orderId,
      externalTxId: txId,
      reason: 'raw_transaction_id',
    };
  }

  if (isAliboLegacy(row.rawPayload, row.link?.network)) {
    return {
      id: row.id,
      orderId: row.orderId,
      externalTxId: `alibo_${row.orderId}`,
      reason: 'alibo_order_id',
    };
  }

  return null;
}

function candidateConflicts(candidates: Candidate[]): Conflict[] {
  const byTarget = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byTarget.get(candidate.externalTxId) ?? [];
    group.push(candidate);
    byTarget.set(candidate.externalTxId, group);
  }

  return [...byTarget.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([externalTxId, group]) => ({
      externalTxId,
      ids: group.map((candidate) => candidate.id),
      reason: 'multiple legacy rows would receive the same externalTxId',
    }));
}

async function existingCollisions(
  prisma: PrismaClient,
  candidates: Candidate[],
): Promise<Conflict[]> {
  const targets = [...new Set(candidates.map((candidate) => candidate.externalTxId))];
  if (targets.length === 0) return [];

  const existing = await prisma.transaction.findMany({
    where: { externalTxId: { in: targets } },
    select: { id: true, externalTxId: true },
  });

  return existing.map((row) => ({
    externalTxId: row.externalTxId ?? '',
    ids: [row.id],
    reason: 'externalTxId already exists on another transaction',
  }));
}

function printStats(stats: Stats): void {
  console.log('Backfill externalTxId summary');
  console.log(`  Missing externalTxId scanned: ${stats.scannedMissing}`);
  console.log(`  Skipped already set:          ${stats.skippedAlreadySet}`);
  console.log(`  Skipped unknown legacy:       ${stats.skippedUnknownLegacy}`);
  console.log(`  Skipped conflict:             ${stats.skippedConflict}`);
  console.log(`  Would update:                 ${stats.wouldUpdate}`);
  console.log(`  Updated:                      ${stats.updated}`);
}

function printCandidates(candidates: Candidate[]): void {
  const preview = candidates.slice(0, 20);
  if (preview.length === 0) return;

  console.log('');
  console.log('Candidate preview:');
  for (const candidate of preview) {
    console.log(
      `  ${candidate.id} order=${candidate.orderId} externalTxId=${candidate.externalTxId} reason=${candidate.reason}`,
    );
  }
  if (candidates.length > preview.length) {
    console.log(`  ... ${candidates.length - preview.length} more`);
  }
}

function printConflicts(conflicts: Conflict[]): void {
  console.error('');
  console.error('Conflicts detected. No rows were updated.');
  for (const conflict of conflicts) {
    console.error(
      `  externalTxId=${conflict.externalTxId} ids=${conflict.ids.join(',')} reason=${conflict.reason}`,
    );
  }
}

async function applyCandidates(
  prisma: PrismaClient,
  candidates: Candidate[],
): Promise<void> {
  const batchSize = 100;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    await prisma.$transaction(
      batch.map((candidate) =>
        prisma.transaction.update({
          where: { id: candidate.id },
          data: { externalTxId: candidate.externalTxId },
        }),
      ),
    );
  }
}

async function main() {
  const { apply } = parseArgs();
  const prisma = new PrismaClient();

  try {
    const skippedAlreadySet = await prisma.transaction.count({
      where: { externalTxId: { not: null } },
    });
    const missing = (await prisma.transaction.findMany({
      where: { externalTxId: null },
      select: {
        id: true,
        orderId: true,
        rawPayload: true,
        link: { select: { network: true } },
      },
      orderBy: { createdAt: 'asc' },
    })) as unknown as BackfillRow[];

    const candidates = missing
      .map((row) => buildCandidate(row))
      .filter((candidate): candidate is Candidate => candidate !== null);
    const conflicts = [
      ...candidateConflicts(candidates),
      ...(await existingCollisions(prisma, candidates)),
    ];

    const stats: Stats = {
      scannedMissing: missing.length,
      skippedAlreadySet,
      skippedUnknownLegacy: missing.length - candidates.length,
      skippedConflict: conflicts.length,
      wouldUpdate: candidates.length,
      updated: 0,
    };

    if (conflicts.length > 0) {
      printStats(stats);
      printConflicts(conflicts);
      process.exitCode = 1;
      return;
    }

    if (apply) {
      await applyCandidates(prisma, candidates);
      stats.updated = candidates.length;
    } else {
      printCandidates(candidates);
      console.log('');
      console.log('Dry run only. Re-run with --apply to write changes.');
    }

    printStats(stats);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
