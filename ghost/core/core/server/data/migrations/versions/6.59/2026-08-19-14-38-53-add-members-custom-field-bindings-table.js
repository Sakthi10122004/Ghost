const {addTable} = require('../../utils');

module.exports = addTable('members_custom_field_bindings', {
    id: {type: 'string', maxlength: 24, nullable: false, primary: true},
    port: {type: 'string', maxlength: 50, nullable: false, unique: true},
    custom_field_key: {
        type: 'string',
        maxlength: 191,
        nullable: false,
        unique: true,
        references: 'members_custom_fields.key',
        cascadeDelete: true
    },
    created_at: {type: 'dateTime', nullable: false},
    updated_at: {type: 'dateTime', nullable: true}
});
