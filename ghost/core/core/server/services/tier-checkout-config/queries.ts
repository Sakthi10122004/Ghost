import type {Knex} from 'knex';
import {FIELD_STATUS} from '../members-custom-fields/schema';
import {DbCheckoutCollection} from './schema';
import {CheckoutQuestionRow, type CheckoutRow} from './codec';

export const QUESTIONS_TABLE = 'products_checkout_fields';
export const CONFIG_TABLE = 'products_checkout_config';
export const BINDINGS_TABLE = 'members_custom_field_bindings';
export const FIELDS_TABLE = 'members_custom_fields';

/** In every ON clause below, so an archived field answers as absent rather than as a status. */
const ACTIVE = FIELD_STATUS.active;

/** Derived from the schemas, so a column added there is read without being named again. */
const questionColumns = Object.keys(CheckoutQuestionRow.shape).map(column => `${QUESTIONS_TABLE}.${column}`);
const collectionColumns = Object.keys(DbCheckoutCollection.shape).map(column => `${CONFIG_TABLE}.${column}`);

/**
 * A tier's whole configuration in one read.
 *
 * Anchored on products, so a tier that only asks questions and a tier that only collects
 * both come back — anchoring on either half would lose one of them. The collection row is
 * one per tier, so joining it against the questions repeats it rather than multiplying
 * them, and every row of a tier carries the same answer to every question but "which
 * question is this".
 *
 * Destinations are joined on a constant rather than on a key, because there is no key: a
 * binding is site-wide, one row per kind of thing, so the row a tier's shipping address
 * lands in is the row whose port says so however many tiers there are. Each is at most one
 * row, so none of them multiplies the result either.
 *
 * Every join to a definition carries `status = 'active'` in its ON clause rather than
 * leaving the status to be compared later. A field that has been archived then answers as
 * absent, which is what it means everywhere it matters: a question that can no longer be
 * asked, and a destination that will no longer collect. Where a thing is *kept* is read off
 * the binding itself, so a read still reports a destination the publisher can restore.
 *
 * A tier that configured nothing never comes back. The predicate is per row rather than
 * per tier, and that is enough: every row of a tier that asks a question carries that
 * question, and a tier that only collects has the one row its collection is on, so anything
 * configured satisfies a branch on every row it has. A tier that turned collection off
 * keeps its row with every flag false and drops out, which is what it should do.
 *
 * Takes the executor so the same query runs standalone or inside a write's transaction.
 */
export function checkoutRows(db: Knex, productId?: string) {
    const query = db('products')
        .leftJoin(QUESTIONS_TABLE, `${QUESTIONS_TABLE}.product_id`, 'products.id')
        .leftJoin(CONFIG_TABLE, `${CONFIG_TABLE}.product_id`, 'products.id')

        .leftJoin({question_field: FIELDS_TABLE}, function () {
            this.on('question_field.key', `${QUESTIONS_TABLE}.custom_field_key`)
                .andOn(db.raw('question_field.status = ?', [ACTIVE]));
        })

        .leftJoin({shipping_binding: BINDINGS_TABLE}, function () {
            this.on(db.raw('shipping_binding.port = ?', ['shipping_address']));
        })
        .leftJoin({shipping_field: FIELDS_TABLE}, function () {
            this.on('shipping_field.key', 'shipping_binding.custom_field_key')
                .andOn(db.raw('shipping_field.status = ?', [ACTIVE]));
        })

        .leftJoin({tax_binding: BINDINGS_TABLE}, function () {
            this.on(db.raw('tax_binding.port = ?', ['tax_number']));
        })
        .leftJoin({tax_field: FIELDS_TABLE}, function () {
            this.on('tax_field.key', 'tax_binding.custom_field_key')
                .andOn(db.raw('tax_field.status = ?', [ACTIVE]));
        })

        .leftJoin({phone_binding: BINDINGS_TABLE}, function () {
            this.on(db.raw('phone_binding.port = ?', ['phone']));
        })
        .leftJoin({phone_field: FIELDS_TABLE}, function () {
            this.on('phone_field.key', 'phone_binding.custom_field_key')
                .andOn(db.raw('phone_field.status = ?', [ACTIVE]));
        })

        .where(function () {
            this.whereNotNull(`${QUESTIONS_TABLE}.id`)
                .orWhere(`${CONFIG_TABLE}.shipping_address_collect`, true)
                .orWhere(`${CONFIG_TABLE}.tax_number_collect`, true)
                .orWhere(`${CONFIG_TABLE}.phone_collect`, true);
        })
        .orderBy('products.id', 'asc')
        .orderBy(`${QUESTIONS_TABLE}.sort_order`, 'asc')
        .orderBy(`${QUESTIONS_TABLE}.id`, 'asc')
        .select<CheckoutRow[]>([
            'products.id as product_id',
            ...questionColumns,
            ...collectionColumns,
            'question_field.name as question_name',
            'question_field.type as question_type',
            'shipping_binding.custom_field_key as shipping_address_key',
            'shipping_field.key as shipping_address_collectable',
            'tax_binding.custom_field_key as tax_number_key',
            'tax_field.key as tax_number_collectable',
            'phone_binding.custom_field_key as phone_key',
            'phone_field.key as phone_collectable'
        ]);

    if (productId) {
        query.where('products.id', productId);
    }
    return query;
}
