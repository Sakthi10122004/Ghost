const {createAddColumnMigration} = require('../../utils');

// Nullable rather than defaulted. Every write from here on states its source — the values
// service takes it as a required argument, so no call site can omit one — but rows written
// before this column existed have no source anybody can recover. Null says exactly that,
// where a default would assert something we would be inventing.
module.exports = createAddColumnMigration('members_custom_field_values', 'source', {
    type: 'string',
    maxlength: 50,
    nullable: true,
    validations: {isIn: [['admin', 'import', 'stripe']]}
});
