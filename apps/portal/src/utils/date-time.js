export const getDateString = (isoDate) => {
    if (!isoDate) {
        return '';
    }
    const event = new Date(isoDate);
    const options = {year: 'numeric', month: 'short', day: 'numeric'};
    return event.toLocaleDateString('en-GB', options);
};

export const getSiteDateString = (isoDate, {locale, timezone} = {}) => {
    if (!isoDate) {
        return '';
    }

    const options = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: timezone || 'Etc/UTC'
    };

    return new Intl.DateTimeFormat(locale || 'en-GB', options).format(new Date(isoDate));
};
