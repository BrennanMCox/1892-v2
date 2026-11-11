// Code node "Queue Messages" (Run Once for All Items).
// Load CRM ran once for the whole run; hand the selected messages on to the
// loop, one at a time.

return $('Select Messages').all().map((i) => ({ json: i.json }));
