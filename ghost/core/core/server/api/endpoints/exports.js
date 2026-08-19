const errors = require('@tryghost/errors');
const models = require('../../models');
const {exportRequestsService} = require('../../services/export-requests/export-requests-service');

const ALLOWED_COMPONENTS = ['content', 'members', 'analytics', 'themes', 'routes', 'media'];

/**
 * Resolves the delivery email server-side from the authenticated user —
 * never trust an email supplied in the request body.
 */
async function resolveRequestedBy(frame) {
    if (frame.user && frame.user.get) {
        return frame.user.get('email');
    }

    if (frame.options.context.user) {
        const user = await models.User.findOne({id: frame.options.context.user});
        return user && user.get('email');
    }

    return null;
}

/** @type {import('@tryghost/api-framework').Controller} */
const controller = {
    docName: 'exports',

    add: {
        statusCode: 202,
        headers: {
            cacheInvalidate: false
        },
        validation(frame) {
            const components = frame.data && frame.data.components;

            if (!components || typeof components !== 'object' || Array.isArray(components)) {
                throw new errors.BadRequestError({
                    message: 'components must be an object'
                });
            }

            const keys = Object.keys(components);
            const unknownKeys = keys.filter(key => !ALLOWED_COMPONENTS.includes(key));

            if (unknownKeys.length > 0) {
                throw new errors.BadRequestError({
                    message: `Unknown export components: ${unknownKeys.join(', ')}`
                });
            }

            if (keys.some(key => typeof components[key] !== 'boolean')) {
                throw new errors.BadRequestError({
                    message: 'Export component values must be booleans'
                });
            }

            if (!keys.some(key => components[key] === true)) {
                throw new errors.BadRequestError({
                    message: 'At least one export component must be selected'
                });
            }
        },
        // Reuses the existing DB export permission — the same audience as the
        // legacy export button (Administrators only for staff sessions).
        permissions: {
            docName: 'db',
            method: 'exportContent'
        },
        async query(frame) {
            const components = {};
            for (const key of ALLOWED_COMPONENTS) {
                components[key] = frame.data.components[key] === true;
            }

            const requestedBy = await resolveRequestedBy(frame);

            if (!requestedBy) {
                throw new errors.NoPermissionError({
                    message: 'Export requests require an authenticated staff user'
                });
            }

            await exportRequestsService.requestArchive({components, requestedBy});
        }
    }
};

module.exports = controller;
