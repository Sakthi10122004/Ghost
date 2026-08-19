import type {Knex} from 'knex';
import type {FieldType} from '@tryghost/custom-field-types';
import {FIELD_STATUS} from './schema';

/** A destination resolved to the field it writes into, for a caller about to write one. */
export interface BoundField {
    key: string;
    type: FieldType;
}

const FIELDS_TABLE = 'members_custom_fields';
const BINDINGS_TABLE = 'members_custom_field_bindings';

/**
 * Where a collected value lands, for whoever is about to write one.
 *
 * The read half of a binding, and all that is left here. Setting one is what turning
 * collection on means, so a tier's checkout configuration writes it in the same transaction
 * that turns collection on; nothing else has a reason to. Reading one is a different
 * caller entirely — a webhook holding a value and no key — which is why this stays.
 */
export class CustomFieldBindingsService {
    private knex: Knex;

    constructor({knex}: {knex: Knex}) {
        this.knex = knex;
    }

    /**
     * The field a kind of collected thing writes into, or null when there is nowhere.
     *
     * Null covers three situations a caller does not need to tell apart: nothing bound,
     * bound to a field since archived, and a kind of thing this build does not know. All
     * three mean the same at the moment of a write, and none of them is an error.
     */
    async resolve(port: string): Promise<BoundField | null> {
        const row = await this.knex(BINDINGS_TABLE)
            .join(FIELDS_TABLE, `${BINDINGS_TABLE}.custom_field_key`, `${FIELDS_TABLE}.key`)
            .where(`${BINDINGS_TABLE}.port`, port)
            .where(`${FIELDS_TABLE}.status`, FIELD_STATUS.active)
            .select(`${FIELDS_TABLE}.key`, `${FIELDS_TABLE}.type`)
            .first();

        return row ? {key: row.key, type: row.type} : null;
    }
}
