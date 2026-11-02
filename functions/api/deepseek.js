const { adaptPages } = require("../_adapter.js");
const handler = require("../../../netlify/functions/deepseek.js");

exports.onRequest = adaptPages(handler.handler);
