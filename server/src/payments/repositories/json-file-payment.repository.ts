import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import Redis from 'ioredis';
import { Payment } from '../entities/payment.entity';
import { PaymentRepository } from './payment-repository.interface';

/**
 * Shape of a payment record as it round-trips through JSON on disk.
 * JSON has no native date type, so `createdAt`/`updatedAt` are stored
 * as ISO strings and must be converted back to `Date` objects when
 * read.
 */
interface SerializedPayment extends Omit<Payment, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

/**
 * Default location of the JSON data file, relative to the process's
 * working directory. Overridable via the `PAYMENTS_DATA_FILE`
 * environment variable, or by passing a path directly to the
 * constructor (used by tests).
 */
const DEFAULT_DATA_FILE = path.join(process.cwd(), 'data', 'payments.json');

/** How long a file lock is held before it's considered abandoned (e.g. a crashed process) and reclaimable. */
const LOCK_TTL_SECONDS = 10;
/** How often to retry acquiring the lock while it's held by someone else. */
const LOCK_RETRY_DELAY_MS = 20;
/** Maximum total time to wait for the lock before giving up. */
const LOCK_MAX_WAIT_MS = 5_000;

/**
 * File-based implementation of `PaymentRepository`, persisting data
 * as JSON on disk, shared by BOTH the API process and the worker
 * process (see `PaymentsCoreModule`).
 *
 * This class went through two real revisions, both discovered via
 * this project's own e2e tests after the API/worker split — worth
 * documenting plainly rather than presenting the final design as if
 * it were obvious from the start:
 *
 * REVISION 1 — remove the in-memory cache. An earlier version loaded
 * the file into an in-memory cache once at startup and served all
 * reads from it. That was fine for a single process, but once the API
 * and worker became genuinely separate processes, the worker's cache
 * (built at ITS OWN startup) could never learn about a payment the
 * API created afterward — every status update the worker tried to
 * make failed with `NotFoundException`, and payments got stuck at
 * PENDING forever. Fixed by having every read (`findById`, `findAll`)
 * go to disk fresh, every time.
 *
 * REVISION 2 — add a cross-process lock around writes. Reading fresh
 * on every write wasn't enough on its own: `create`/`update` still
 * followed a "read the whole array, modify it, write the whole array
 * back" pattern, and TWO SEPARATE PROCESSES each doing that around
 * the same moment — e.g. the worker mid-processing one payment (during
 * its 1-3s simulated delay) while the API creates an unrelated new
 * payment — could genuinely clobber each other: whichever process's
 * write finished last would overwrite the file with an array that
 * didn't include the other process's addition, silently losing it.
 * This was caught by this project's own e2e suite (a payment
 * disappeared from the list moments after being created). Fixed by
 * acquiring a Redis-backed lock (`SET ... NX EX`, the same primitive
 * `IdempotencyStore` uses) around the read-modify-write cycle, so only
 * one process's mutation is ever in flight at a time, regardless of
 * which process it is.
 *
 * Each write is also still atomic at the filesystem level (write to a
 * uniquely-named temp file, then `fs.rename` over the real file) —
 * the temp filename includes this process's PID and a random suffix
 * specifically because a FIXED temp filename shared across two
 * processes caused a real `ENOENT` crash when both tried to rename
 * around the same moment.
 */
@Injectable()
export class JsonFilePaymentRepository implements PaymentRepository, OnModuleInit {
  private readonly logger = new Logger(JsonFilePaymentRepository.name);
  private readonly filePath: string;
  private readonly lockKey: string;

  constructor(
    filePath: string = DEFAULT_DATA_FILE,
    private readonly redisClient: Redis,
  ) {
    this.filePath = filePath;
    this.lockKey = `payments-file-lock:${filePath}`;
  }

  /**
   * Ensures the data file exists on startup (creating an empty one if
   * not) and logs how many payments are currently on disk. Purely a
   * startup convenience/log — every subsequent read still goes to
   * disk fresh, nothing here is cached.
   */
  async onModuleInit(): Promise<void> {
    await this.ensureDataFileExists();
    const payments = await this.readFromDisk();
    this.logger.log(
      `Found ${payments.length} payment(s) in ${this.filePath}`,
    );
  }

  async create(payment: Payment): Promise<Payment> {
    await this.ensureDataFileExists();
    await this.withLock(async () => {
      const payments = await this.readFromDisk();
      payments.push(payment);
      await this.writeAtomically(payments);
    });
    return payment;
  }

  async findById(id: string): Promise<Payment | null> {
    await this.ensureDataFileExists();
    const payments = await this.readFromDisk();
    return payments.find((p) => p.id === id) ?? null;
  }

  async update(payment: Payment): Promise<Payment> {
    await this.ensureDataFileExists();
    await this.withLock(async () => {
      const payments = await this.readFromDisk();
      const index = payments.findIndex((p) => p.id === payment.id);
      if (index === -1) {
        payments.push(payment);
      } else {
        payments[index] = payment;
      }
      await this.writeAtomically(payments);
    });
    return payment;
  }

  async findAll(): Promise<Payment[]> {
    await this.ensureDataFileExists();
    return this.readFromDisk();
  }

  /** Creates the data directory and an empty data file if they don't already exist. */
  private async ensureDataFileExists(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, '[]', 'utf-8');
    }
  }

  /**
   * Reads and parses the JSON file, converting date strings back into
   * `Date` objects.
   */
  private async readFromDisk(): Promise<Payment[]> {
    const raw = await fs.readFile(this.filePath, 'utf-8');
    const parsed: SerializedPayment[] = JSON.parse(raw);

    return parsed.map((p) => ({
      ...p,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    }));
  }

  /**
   * Runs `criticalSection` while holding a Redis-backed lock scoped to
   * this file path, so only one process's read-modify-write cycle is
   * ever in flight at a time — whether the two competing calls come
   * from this same process or from a completely different one. This
   * is what actually closes the "two processes clobber each other's
   * writes" gap described in the class doc comment; the previous
   * design's process-local `writeQueue` could only ever serialize
   * writes within one process, which is not what "shared datastore
   * across two processes" requires.
   */
  private async withLock<T>(criticalSection: () => Promise<T>): Promise<T> {
    const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const start = Date.now();

    // Poll for the lock rather than blocking indefinitely — if it's
    // held by a crashed process, LOCK_TTL_SECONDS guarantees it's
    // eventually reclaimable rather than stuck forever.
    for (;;) {
      const acquired = await this.redisClient.set(
        this.lockKey,
        lockValue,
        'EX',
        LOCK_TTL_SECONDS,
        'NX',
      );
      if (acquired === 'OK') {
        break;
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(
          `Timed out waiting for the file lock on ${this.filePath}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }

    try {
      return await criticalSection();
    } finally {
      // Best-effort release. Not using a compare-and-delete Lua script
      // here (checking `lockValue` still matches before deleting) — at
      // this project's scale, the TTL safety net is sufficient, and a
      // CAS-delete would be the natural next hardening step for a
      // higher-throughput production deployment.
      await this.redisClient.del(this.lockKey);
    }
  }

  /**
   * Writes `payments` to a uniquely-named temporary file, then renames
   * it over the real data file. The temp filename includes this
   * process's PID and a random component — NOT a fixed `${filePath}.tmp`
   * — because a fixed shared temp filename caused a genuine `ENOENT`
   * crash when the API and worker processes happened to write around
   * the same moment (one process's rename removed the temp file just
   * as the other's rename tried to use that same now-gone path).
   */
  private async writeAtomically(payments: Payment[]): Promise<void> {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const serialized = JSON.stringify(payments, null, 2);

    await fs.writeFile(tempPath, serialized, 'utf-8');
    await fs.rename(tempPath, this.filePath);
  }
}
