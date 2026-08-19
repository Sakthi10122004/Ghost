import ObjectID from 'bson-objectid';
import errors from '@tryghost/errors';
import {z} from 'zod';
import type {Knex} from 'knex';
import {FIELD_STATUS} from '../members-custom-fields/schema';
import {CHECKOUT_ELIGIBLE_FIELD_TYPES, MAX_CHECKOUT_LABEL_LENGTH} from '../stripe/services/checkout/field-ports';
import {DbCheckoutCollection} from './schema';
import {checkoutQuestionCodec, checkoutRowCodec, collectionCodec, type CheckoutRowParts} from './codec';
import {BINDINGS_TABLE, CONFIG_TABLE, FIELDS_TABLE, QUESTIONS_TABLE, checkoutRows} from './queries';
import {
    emptyCheckoutConfig,
    type CheckoutConfigResult,
    type ResolvedCheckout,
    type ResolvedQuestion,
    type StoredCollection,
    type TierCheckoutConfig
} from './models';
import {CheckoutConfigInput} from './serializers';

/**
 * What a tier's checkout asks and collects.
 *
 * ## The rule this lives by
 *
 * A tier says what its checkout asks. Where the answers land is either already settled or
 * settled site-wide, and never per tier. A question's answer comes back under the key Ghost
 * sent with it, so the field a publisher picked *is* the destination. What a processor
 * collects under its own vocabulary comes back with no key at all, so a tier says whether
 * to collect it and a binding says where it goes.
 *
 * Bindings are written from here rather than through anything else. Creating one is what
 * turning collection on *means*, so it belongs in the same statement and the same
 * transaction: a tier that saved its collection but not its destination would collect into
 * nowhere, and the reverse would move every other tier's destination for a write that
 * failed.
 *
 * ## What is validated, and what is tolerated
 *
 * Refused at write, tolerated at read. A question naming an archived field, or a collection
 * whose destination has since been archived, stops being asked and stays in the table, so
 * restoring the field brings it back without the publisher rebuilding anything.
 */

/** The kinds of thing, as the bindings table names them. */
const SHIPPING_ADDRESS = 'shipping_address';
const TAX_NUMBER = 'tax_number';
const PHONE = 'phone';

interface FieldRow {
    key: string;
    name: string;
    type: string;
    status: string;
}

export class TierCheckoutConfigService {
    private knex: Knex;

    constructor({knex}: {knex: Knex}) {
        this.knex = knex;
    }

    /**
     * Every tier that has configured something, each as one aggregate.
     *
     * One query, folded into objects. Everything a configuration is made of arrives on the
     * same row — the questions, the collection columns, and the destination each collected
     * thing currently has — and which tiers count as configured is settled by the query
     * too, so nothing is looked up or sifted a second time.
     */
    async browse(): Promise<CheckoutConfigResult> {
        return {tiers: [...fold(await this.readRows()).values()]};
    }

    async read(productId: string): Promise<CheckoutConfigResult> {
        const configs = fold(await this.readRows(productId));
        return {tiers: [configs.get(productId) ?? emptyCheckoutConfig(productId)]};
    }

    /** Every row the joined read returns, each already read as the parts it carries. */
    private async readRows(productId?: string): Promise<CheckoutRowParts[]> {
        const rows = await checkoutRows(this.knex, productId);
        return rows.map(row => z.decode(checkoutRowCodec, row));
    }

    /**
     * What this tier's checkout should actually ask right now.
     *
     * Resolved against what is live rather than what was true when the rows were written: a
     * question naming a field since archived, and a collection whose destination has since
     * been archived, both drop out here rather than reaching the processor. The rows stay,
     * so restoring either brings it back.
     */
    async resolve(productId: string): Promise<ResolvedCheckout> {
        const rows = await this.readRows(productId);
        const [row] = rows;
        if (!row) {
            return {customFields: [], shippingAddress: null, taxNumber: null, phone: null};
        }

        // Everything unusable already answered as absent when the row was read, so nothing
        // is decided here: a question whose field was archived has no `askable`, and
        // `collecting` is already only what has somewhere active to go.
        const customFields: ResolvedQuestion[] = rows
            .filter(candidate => candidate.question && candidate.askable)
            .map(candidate => ({...candidate.question!, ...candidate.askable!}));

        return {customFields, ...row.collecting};
    }

    /**
     * State a tier's checkout configuration. Each part is replaced whole, and a part the
     * request does not name is left as it was.
     *
     * One transaction for all of it, destinations included. A publisher stated one thing,
     * and it either happened or it did not.
     */
    async edit(productId: string, input: unknown): Promise<CheckoutConfigResult> {
        const parsed = CheckoutConfigInput.safeParse(input);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new errors.ValidationError({message: issue.message, property: issue.path.join('.') || 'checkout'});
        }
        const stated = parsed.data;
        const now = new Date();

        await this.knex.transaction(async (trx) => {
            if (stated.custom_fields) {
                await this.writeQuestions(trx, productId, stated.custom_fields, now);
            }
            if (stated.shipping_address) {
                await writeBinding(trx, SHIPPING_ADDRESS, stated.shipping_address, 'address', now);
            }
            if (stated.tax_number) {
                await writeBinding(trx, TAX_NUMBER, stated.tax_number, 'short_text', now);
            }
            if (stated.phone) {
                await writeBinding(trx, PHONE, stated.phone, 'short_text', now);
            }
            if (stated.shipping_address || stated.tax_number || stated.phone) {
                await writeCollection(trx, productId, stated, now);
            }
        });

        return this.read(productId);
    }

    private async writeQuestions(
        trx: Knex.Transaction,
        productId: string,
        questions: NonNullable<CheckoutConfigInput['custom_fields']>,
        now: Date
    ): Promise<void> {
        await assertQuestionsAskable(trx, questions);

        await trx(QUESTIONS_TABLE).where('product_id', productId).del();
        if (questions.length === 0) {
            return;
        }
        await trx(QUESTIONS_TABLE).insert(questions.map((question, index) => ({
            id: new ObjectID().toHexString(),
            product_id: productId,
            sort_order: index,
            created_at: now,
            ...z.encode(checkoutQuestionCodec, {
                key: question.key,
                label: question.label ?? null,
                optional: question.optional ?? true
            })
        })));
    }

}

/**
 * Group rows into one aggregate per tier.
 *
 * Only grouping. What each row contributes was decided when it was read, so there is nothing
 * to branch on here — a part that is present is a part that belongs, and the collection
 * repeats identically on every row of a tier because it came from one row of one table.
 */
function fold(rows: CheckoutRowParts[]): Map<string, TierCheckoutConfig> {
    const configs = new Map<string, TierCheckoutConfig>();

    for (const row of rows) {
        const config = configs.get(row.tierId) ?? emptyCheckoutConfig(row.tierId);
        if (row.question) {
            config.customFields.push(row.question);
        }
        if (row.collection) {
            Object.assign(config, row.collection);
        }
        configs.set(row.tierId, config);
    }

    return configs;
}

/**
 * Point a kind of thing at one of the publisher's fields, or at nothing.
 *
 * Read-then-write rather than an upsert, because the two unique indexes mean different
 * things and the engines disagree about which one an upsert answers to. MySQL's ON DUPLICATE
 * KEY UPDATE fires on whichever index was hit, so a clash on `custom_field_key` would
 * quietly rewrite a different kind's destination; SQLite, told to conflict on the port,
 * raises instead. Deciding here makes both behave the same, and the indexes stay as the
 * backstop.
 */
async function writeBinding(
    trx: Knex.Transaction,
    port: string,
    stated: {collect: boolean; custom_field_key?: string},
    valueType: string,
    now: Date
): Promise<void> {
    if (!stated.collect) {
        await trx(BINDINGS_TABLE).where({port}).del();
        return;
    }

    const field = await trx(FIELDS_TABLE).where('key', stated.custom_field_key!).first();
    if (!field) {
        throw new errors.ValidationError({
            message: `Unknown custom field: ${stated.custom_field_key}`,
            property: `checkout.${port}.custom_field_key`
        });
    }
    // An archived field is not a destination. Binding to one would leave a checkout
    // collecting into somewhere the publisher has already put out of reach.
    if (field.status !== FIELD_STATUS.active) {
        throw new errors.ValidationError({
            message: 'An archived custom field cannot receive collected data. Restore it first.',
            property: `checkout.${port}.custom_field_key`
        });
    }
    // Matching exactly rather than by what would happen to parse, so a value already checked
    // against what a checkout collects needs no second thought at the field.
    if (field.type !== valueType) {
        throw new errors.ValidationError({
            message: `This can only be collected into a ${valueType} field.`,
            property: `checkout.${port}.custom_field_key`
        });
    }

    const clash = await trx(BINDINGS_TABLE).where('custom_field_key', stated.custom_field_key!).first();
    if (clash && clash.port !== port) {
        throw new errors.ValidationError({
            message: `This custom field already collects a ${clash.port.replace(/_/g, ' ')}.`,
            property: `checkout.${port}.custom_field_key`
        });
    }

    const updated = await trx(BINDINGS_TABLE)
        .where({port})
        .update({custom_field_key: stated.custom_field_key!, updated_at: now});
    if (updated === 0) {
        await trx(BINDINGS_TABLE).insert({
            id: new ObjectID().toHexString(),
            port,
            custom_field_key: stated.custom_field_key!,
            created_at: now,
            updated_at: now
        });
    }
}

/**
 * Read, merge, upsert, all on the transaction's executor.
 *
 * What a request names is merged over what the tier already collects, so a body that says
 * nothing about the phone number leaves it alone. The merge happens here rather than in the
 * upsert because the domain object is the unit of writing: a whole collection is encoded to
 * columns, which is also what lets a configuration be read and handed straight back.
 *
 * One unique index on this table and no other, so the conflict target is unambiguous and
 * both engines agree on what it means. The read has to run on `trx` and not the base
 * connection: a single-connection pool would deadlock reading around an open transaction.
 */
async function writeCollection(
    trx: Knex.Transaction,
    productId: string,
    stated: CheckoutConfigInput,
    now: Date
): Promise<void> {
    const row = await trx(CONFIG_TABLE).where('product_id', productId).first();
    const merged: StoredCollection = row
        ? z.decode(collectionCodec, row as unknown as z.input<typeof DbCheckoutCollection>)
        : {shippingAddress: null, taxNumber: false, phone: false};

    if (stated.shipping_address) {
        merged.shippingAddress = stated.shipping_address.collect
            ? {allowedCountries: stated.shipping_address.allowed_countries ?? []}
            : null;
    }
    if (stated.tax_number) {
        merged.taxNumber = stated.tax_number.collect;
    }
    if (stated.phone) {
        merged.phone = stated.phone.collect;
    }

    const columns = z.encode(collectionCodec, merged);
    await trx(CONFIG_TABLE)
        .insert({
            id: new ObjectID().toHexString(),
            product_id: productId,
            created_at: now,
            updated_at: now,
            ...columns
        })
        .onConflict('product_id')
        // Named rather than bare, so a conflict rewrites what the tier collects and leaves
        // the row's identity and its created_at as they were.
        .merge({...columns, updated_at: now});
}

/**
 * What only the definitions can answer: may this field be asked for, and is something
 * already collecting into it.
 *
 * How many questions there may be, and that none repeats, are rules about the request and
 * are settled by the schema before this runs.
 */
async function assertQuestionsAskable(
    trx: Knex.Transaction,
    questions: NonNullable<CheckoutConfigInput['custom_fields']>
): Promise<void> {
    const keys = questions.map(question => question.key);
    if (keys.length === 0) {
        return;
    }

    const rows: Array<FieldRow & {bound_port: string | null}> = await trx(FIELDS_TABLE)
        .leftJoin(BINDINGS_TABLE, `${BINDINGS_TABLE}.custom_field_key`, `${FIELDS_TABLE}.key`)
        .whereIn(`${FIELDS_TABLE}.key`, keys)
        .where(`${FIELDS_TABLE}.status`, FIELD_STATUS.active)
        .select(
            `${FIELDS_TABLE}.key`,
            `${FIELDS_TABLE}.name`,
            `${FIELDS_TABLE}.type`,
            `${FIELDS_TABLE}.status`,
            `${BINDINGS_TABLE}.port as bound_port`
        );
    const byKey = new Map(rows.map(row => [row.key, row]));

    for (const question of questions) {
        const field = byKey.get(question.key);
        if (!field) {
            throw new errors.ValidationError({
                message: `Unknown custom field: ${question.key}`,
                property: 'checkout.custom_fields'
            });
        }
        if (!CHECKOUT_ELIGIBLE_FIELD_TYPES.includes(field.type as never)) {
            throw new errors.ValidationError({
                message: `A ${field.type} field cannot be asked for at checkout.`,
                property: 'checkout.custom_fields'
            });
        }
        // A field something already collects into would be asked twice on the same page.
        if (field.bound_port) {
            throw new errors.ValidationError({
                message: `${field.name} is already collected automatically, so the checkout would ask for it twice.`,
                property: 'checkout.custom_fields'
            });
        }
        const prompt = question.label ?? field.name;
        if (prompt.length > MAX_CHECKOUT_LABEL_LENGTH) {
            throw new errors.ValidationError({
                message: `A checkout question can be at most ${MAX_CHECKOUT_LABEL_LENGTH} characters. Give this one a shorter label.`,
                property: 'checkout.custom_fields'
            });
        }
    }
}
