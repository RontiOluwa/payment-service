import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Payment } from '../entities/payment.entity';
import { PaymentRepository } from './payment-repository.interface';

/**
 * Shape of a payment record as it round-trips through JSON on disk.
 * JSON has no native date type, so `createdAt`/`updatedAt` are stored
 * as ISO strings and must be converted back to `Date` objects when
 * read. Defined as its own named interface (rather than an inline
 * `Omit<...> & { ... }` type assertion) so the shape is easy to read
 * and not sensitive to how the surrounding expression is formatted.
 */
interface SerializedPayment extends Omit<Payment, 'createdAt' | 'updatedAt'> {
    createdAt: string;
    updatedAt: string;
}

/**
 * Default location of the JSON data file, relative to the process's
 * working directory. Overridable via the `PAYMENTS_DATA_FILE`
 * environment variable (see `.env.example`), or by passing a path
 * directly to the constructor (used by tests to avoid touching the
 * real data file).
 */
const DEFAULT_DATA_FILE = path.join(process.cwd(), 'data', 'payments.json');

/**
 * File-based implementation of `PaymentRepository`, persisting data
 * as JSON on disk.
 *
 * Design:
 *  - On startup (`onModuleInit`), the JSON file is read once into an
 *    in-memory `Map`. All reads (`findById`, `findAll`) serve from
 *    this cache — no disk I/O happens on the read path, so retrieval
 *    stays fast regardless of storage backend.
 *  - Every write (`create`, `update`) updates the cache AND persists
 *    the full dataset to disk before resolving, so a crash right
 *    after a successful `POST /payments` response does not lose that
 *    payment.
 *  - Writes are serialized through `writeQueue`, a promise chain that
 *    guarantees only one write to the file happens at a time — two
 *    concurrent requests creating payments will not race and corrupt
 *    each other's writes.
 *  - Each write is atomic at the filesystem level: data is written to
 *    a temporary file first, then renamed over the real file.
 *    `fs.rename` is atomic on POSIX filesystems, so a process crash
 *    mid-write leaves the previous, valid file intact rather than a
 *    half-written, corrupt JSON file.
 *
 * This is a genuinely more complex implementation than
 * `InMemoryPaymentRepository` — that complexity is the direct cost of
 * the durability it buys (payments survive an app restart), which is
 * exactly the trade-off discussed when choosing to add this
 * implementation.
 */
@Injectable()
export class JsonFilePaymentRepository implements PaymentRepository, OnModuleInit {
    private readonly logger = new Logger(JsonFilePaymentRepository.name);
    private readonly filePath: string;
    private cache = new Map<string, Payment>();

    /**
     * A promise chain used purely to serialize writes. Each write
     * appends `.then(...)` onto this chain rather than calling
     * `fs.writeFile` directly, guaranteeing writes run one after
     * another even if multiple requests call `create`/`update` at
     * nearly the same time.
     */
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(filePath: string = DEFAULT_DATA_FILE) {
        this.filePath = filePath;
    }

    /**
     * Loads existing data from disk into the in-memory cache when the
     * module starts. If the file (or its directory) doesn't exist yet,
     * it's created with an empty dataset — this is what makes a fresh
     * checkout of the project "just work" with no manual setup step.
     */
    async onModuleInit(): Promise<void> {
        await this.ensureDataFileExists();
        const payments = await this.readFromDisk();
        this.cache = new Map(payments.map((p) => [p.id, p]));
        this.logger.log(
            `Loaded ${this.cache.size} payment(s) from ${this.filePath}`,
        );
    }

    async create(payment: Payment): Promise<Payment> {
        this.cache.set(payment.id, payment);
        await this.persist();
        return payment;
    }

    async findById(id: string): Promise<Payment | null> {
        return this.cache.get(id) ?? null;
    }

    async update(payment: Payment): Promise<Payment> {
        this.cache.set(payment.id, payment);
        await this.persist();
        return payment;
    }

    async findAll(): Promise<Payment[]> {
        return Array.from(this.cache.values());
    }

    /**
     * Creates the data directory and an empty data file if they don't
     * already exist. Safe to call every startup — `fs.mkdir` with
     * `recursive: true` and a check for existing file both no-op
     * cleanly when things are already in place.
     */
    private async ensureDataFileExists(): Promise<void> {
        const dir = path.dirname(this.filePath);
        await fs.mkdir(dir, { recursive: true });

        try {
            await fs.access(this.filePath);
        } catch {
            // File doesn't exist yet — initialize it with an empty array.
            await fs.writeFile(this.filePath, '[]', 'utf-8');
        }
    }

    /**
     * Reads and parses the JSON file, converting date strings back into
     * `Date` objects (JSON has no native date type, so `createdAt`/
     * `updatedAt` round-trip as ISO strings and must be reconstructed).
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
     * Enqueues a write of the entire current cache to disk, chained
     * after any write already in progress. Returns the promise for
     * *this* write specifically, so callers (`create`/`update`) can
     * `await` until their own data is confirmed durable — not just
     * until some earlier write finishes.
     */
    private persist(): Promise<void> {
        const snapshot = Array.from(this.cache.values());

        const thisWrite = this.writeQueue.then(() =>
            this.writeAtomically(snapshot),
        );

        // Swallow errors on the shared chain itself so one failed write
        // doesn't permanently break the queue for subsequent writes —
        // the specific error is still surfaced to the caller via
        // `thisWrite`, which is returned (and awaited) below.
        this.writeQueue = thisWrite.catch(() => undefined);

        return thisWrite;
    }

    /**
     * Writes `payments` to a temporary file, then renames it over the
     * real data file. `fs.rename` is atomic on POSIX filesystems, so
     * readers never observe a partially-written file.
     */
    private async writeAtomically(payments: Payment[]): Promise<void> {
        const tempPath = `${this.filePath}.tmp`;
        const serialized = JSON.stringify(payments, null, 2);

        await fs.writeFile(tempPath, serialized, 'utf-8');
        await fs.rename(tempPath, this.filePath);
    }
}