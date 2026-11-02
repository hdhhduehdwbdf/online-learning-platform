const { adaptPages } = require("../_adapter.js");
const handler = require("../../../netlify/functions/section-chat.js");

exports.onRequest = adaptPages(handler.handler);
