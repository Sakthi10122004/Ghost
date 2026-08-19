/**
 * What Stripe Checkout will render, measured rather than read.
 *
 * Every number here came from probing the live API at Ghost's pinned version, not from the
 * reference or the published OpenAPI spec — the spec disagreed with the API in three of five
 * probes, missing the field cap and the key format entirely. A wrong bound is not cosmetic:
 * an over-long label fails the session create, which fails the checkout.
 */

/** Stripe rejects a fourth. */
export const MAX_CHECKOUT_CUSTOM_FIELDS = 3;

/**
 * Stripe caps a custom label at 50 characters and our field names at 191, so a publisher can
 * name a field something that cannot be asked. A tier's question carries its own label for
 * exactly this, and this is the bound it is held to.
 */
export const MAX_CHECKOUT_LABEL_LENGTH = 50;

/**
 * The field types Stripe Checkout can ask for. `long_text` is missing because Stripe's text
 * input caps shorter than that type allows, and `address` because Stripe has no custom-field
 * equivalent — an address is collected through its own parameter instead.
 */
export const CHECKOUT_ELIGIBLE_FIELD_TYPES = ['short_text'] as const;
