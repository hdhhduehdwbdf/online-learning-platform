const { adaptPages } = require("../_adapter.js");
const handler = require("../../../netlify/functions/coordinator-chat.js");

exports.onRequest = adaptPages(handler.handler);
