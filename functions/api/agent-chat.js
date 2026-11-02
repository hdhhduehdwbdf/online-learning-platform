const { adaptPages } = require("../_adapter.js");
const handler = require("../../../netlify/functions/agent-chat.js");

exports.onRequest = adaptPages(handler.handler);
