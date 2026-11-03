const { adaptPages } = require("../_adapter.js");
const handler = require("../../../netlify/functions/section-chat.js");

const onRequest = adaptPages(handler.handler);

module.exports = { onRequest };
module.exports.onRequest = onRequest;
